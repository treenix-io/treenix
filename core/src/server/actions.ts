// Treenix Actions — Layer 4
// Server-specific: ActionCtx, SchemaHandler, client proxy
// Component registration lives in @/comp

import { chain, type Chain } from '#chain';
import { Class, type TypeProxy } from '#comp';
import { type ExecuteFn, makeTypedProxy, type StreamFn } from '#comp/handle';
import { collectDeps as _collectDeps, type ResolvedDeps } from '#comp/needs';
import { type ComponentData, getComponentField, isComponent, type NodeData, register, resolve } from '#core';
import { validateValue, type ValidationError } from '#comp/validate';
import { type TypeSchema } from '#schema/types';
import { type PatchOp, type Tree } from '#tree';
import { createDraft, enablePatches, finishDraft, type Patch } from 'immer';
import { createPathLock } from '#util/path-lock';
import { OpError } from '#errors';

function validateActionArgs(type: string, action: string, data: unknown): void {
  const schemaFn = resolve(type, 'schema');
  const methodSchema = schemaFn?.()?.methods?.[action];

  if (!methodSchema) {
    const msg = `[SECURITY] No schema for ${type}.${action} — action args not validated`;
    if (process.env.NODE_ENV === 'development') { console.error(msg); return; }
    throw new OpError('BAD_REQUEST', msg);
  }

  const argSchema = methodSchema.arguments?.[0];
  if (!argSchema?.type) return;

  const actual = data ?? {};
  const errors: ValidationError[] = [];
  validateValue(actual, argSchema, `${type}.${action}`, errors);
  if (errors.length) {
    throw new OpError('BAD_REQUEST', `Invalid action args: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  }
}

function immerToPatchOps(patches: Patch[]): PatchOp[] {
  return patches.map(p => {
    const path = p.path.join('.');
    if (p.op === 'remove') return ['d', path] as const;
    return [p.op === 'replace' ? 'r' : 'a', path, p.value] as const;
  });
}

export type NodeHandle = ReturnType<typeof serverNodeHandle>;

/** @opaque Runtime-injected, not part of public schema */
export type ActionCtx = {
  node: NodeData;
  tree: Tree;
  signal: AbortSignal;
  /** Typed client for cross-node action calls: ctx.nc(path).get(Type).method(data) */
  nc: NodeHandle;
  comp?: ComponentData;
  deps?: ResolvedDeps;
  /** User who triggered this action (null for system/anonymous) */
  userId?: string | null;
};

// ── Client proxy ──

export type { ExecuteInput } from '#comp/handle';

export function createNodeHandle(
  execute: ExecuteFn,
  stream: StreamFn,
  getNode?: (path: string) => NodeData | undefined,
) {
  return (path: string) => ({
    get<T extends object>(cls: Class<T>, key?: string): Chain<TypeProxy<T>> {
      return chain(makeTypedProxy(getNode?.(path), cls, path, execute, stream, key)) as Chain<TypeProxy<T>>;
    },
  });
}
// Server-side typed node client: wraps executeAction/executeStream into createNodeHandle.
// Usage: const nc = serverNodeHandle(tree); await nc(path).get(MyComp).myMethod();
export function serverNodeHandle(tree: Tree) {
  return createNodeHandle(
    (input) => executeAction(tree, input.path, input.type, input.key, input.action, input.data),
    (input) => executeStream(tree, input.path, input.type, input.key, input.action, input.data),
  );
}

export { collectSiblings, collectDeps } from '#comp/needs';
export { registerActionNeeds, getActionNeeds } from '#comp/needs';

// ── Server-side operations ──
// Single entry point for tRPC, MCP, cook-bot, services — no boilerplate.
// All ops throw OpError for domain errors (NOT_FOUND, BAD_REQUEST, CONFLICT).
enablePatches();

// Action timeout: env-configurable, default 5 min (was 30s)
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT) || 300_000;
const STREAM_TIMEOUT = Number(process.env.STREAM_TIMEOUT) || 600_000;

// ── Shared resolution: find handler + component for any action call ──
// Resolution order:
//   key given → node[key], verify $type === type (if type given)
//   type given, no key → scan components for first matching $type
//   neither → node.$type, then scan components for matching action handler

type ResolvedAction = {
  node: NodeData;
  handler: (ctx: ActionCtx, data: unknown) => unknown;
  type: string;
  comp: ComponentData | undefined;
  deps: ResolvedDeps;
  fieldKey: string | undefined;
};

// Dynamic actions: load from /sys/types/{ns}/{name} node's `actions` field.
// Code runs in QuickJS WASM sandbox — no host FS/network/process access (C01 fix).
// Sandbox gets: ctx.node (snapshot), ctx.tree.get/set/remove, data, Date, console.log.

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const DYNAMIC_ACTION_TIMEOUT = 5_000;
const DYNAMIC_ACTION_MEM = 8 * 1024 * 1024;

async function loadDynamicAction(
  tree: Tree, type: string, action: string,
): Promise<((ctx: ActionCtx, data: unknown) => unknown) | null> {
  if (!type.includes('.')) return null;

  const typePath = `/sys/types/${type.replace(/\./g, '/')}`;
  const typeNode = await tree.get(typePath);
  const actionCode = (typeNode as any)?.actions?.[action];
  if (!actionCode || typeof actionCode !== 'string') return null;

  // Register schema from type node's `schema` field
  if (!resolve(type, 'schema')) {
    const nodeSchema = (typeNode as Record<string, unknown>).schema;
    if (!nodeSchema || typeof nodeSchema !== 'object') return null;
    const s = { $id: type, ...(nodeSchema as Record<string, unknown>) };
    register(type, 'schema', () => s as unknown as TypeSchema);
  }

  // Build a sandboxed action handler — compiled once, called per invocation
  const fn = async (ctx: ActionCtx, data: unknown): Promise<unknown> => {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(DYNAMIC_ACTION_MEM);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DYNAMIC_ACTION_TIMEOUT));
    const vm = runtime.newContext();

    // Collect async operations from sandbox — QuickJS is sync, so we queue them
    const pendingOps: Array<{ resolve: (v: string) => void; promise: Promise<string> }> = [];

    try {
      // Inject `data` as global
      const dataHandle = vm.evalCode(`(${JSON.stringify(data ?? {})})`);
      if ('value' in dataHandle) { vm.setProp(vm.global, 'data', dataHandle.value); dataHandle.value.dispose(); }

      // Inject `ctx` with node snapshot + tree bridge stubs
      // Tree ops are async — we use a sync→async bridge pattern:
      // sandbox calls ctx.tree.get(path) → returns a placeholder
      // we track the call, run it on host, and re-execute with results
      const nodeSnapshot = { ...ctx.node };
      const nodeJson = JSON.stringify(nodeSnapshot);

      // Simple approach: wrap action code in async-like sequential execution
      // The sandbox code can call ctx.tree.get/set synchronously — we proxy through host fns
      let treeOpsResult: unknown = undefined;
      const treeWrites: Array<{ node: Record<string, unknown> }> = [];
      const treeGets = new Map<string, Record<string, unknown> | undefined>();

      // Pre-fetch the action node itself
      treeGets.set(ctx.node.$path, nodeSnapshot);

      // Host function: ctx_tree_get(path) → JSON string
      const getFn = vm.newFunction('ctx_tree_get', (pathHandle) => {
        const p = vm.getString(pathHandle);
        // Return cached or placeholder — will be filled in re-execution
        const cached = treeGets.get(p);
        if (cached !== undefined) return vm.newString(JSON.stringify(cached));
        return vm.newString('null');
      });
      vm.setProp(vm.global, 'ctx_tree_get', getFn);
      getFn.dispose();

      // Host function: ctx_tree_set(nodeJson) → void
      const setFn = vm.newFunction('ctx_tree_set', (nodeJsonHandle) => {
        const nj = vm.getString(nodeJsonHandle);
        try { treeWrites.push({ node: JSON.parse(nj) }); } catch {}
        return vm.undefined;
      });
      vm.setProp(vm.global, 'ctx_tree_set', setFn);
      setFn.dispose();

      // Console stub
      const logFn = vm.newFunction('log', (...args) => {
        const parts = args.map(a => vm.getString(a));
        console.log(`[sandbox:${type}.${action}]`, ...parts);
      });
      const consoleObj = vm.newObject();
      vm.setProp(consoleObj, 'log', logFn);
      vm.setProp(vm.global, 'console', consoleObj);
      consoleObj.dispose();
      logFn.dispose();

      // Wrapper: provides ctx.node, ctx.store (legacy alias), ctx.tree as sync bridge
      // Dynamic action code uses `await ctx.store.get(path)` — in sandbox we strip await (sync)
      // Sanitize: strip security-sensitive fields from snapshot
      const sanitized = { ...nodeSnapshot };
      delete (sanitized as any).$acl;
      delete (sanitized as any).$owner;
      delete (sanitized as any).$refs;
      const sanitizedJson = JSON.stringify(sanitized);

      const wrapperCode = `
        var ctx = {
          node: ${sanitizedJson},
          tree: {
            get: function(p) { var r = ctx_tree_get(p); return r === 'null' ? null : JSON.parse(r); },
            set: function(n) { ctx_tree_set(JSON.stringify(n)); },
          },
        };
        ctx.store = ctx.tree;
        (function() { ${actionCode.replace(/await\s+/g, '')} })();
      `;

      const result = vm.evalCode(wrapperCode);
      if (result.error) {
        const err = vm.dump(result.error);
        result.error.dispose();
        throw new Error(`Dynamic action ${type}.${action} failed: ${typeof err === 'object' && err ? (err as any).message ?? JSON.stringify(err) : err}`);
      }

      treeOpsResult = vm.dump(result.value);
      result.value.dispose();

      // Apply tree writes to real tree — scoped to own path or children only
      const nodePath = ctx.node.$path;
      for (const w of treeWrites) {
        const n = w.node;
        if (n && typeof n === 'object' && typeof n.$path === 'string' && typeof n.$type === 'string') {
          if (n.$path !== nodePath && !n.$path.startsWith(nodePath + '/')) {
            console.warn(`[sandbox:${type}.${action}] blocked write to ${n.$path} (outside ${nodePath})`);
            continue;
          }
          // Strip security-sensitive fields from sandbox writes
          delete (n as any).$acl;
          delete (n as any).$owner;
          delete (n as any).$refs;
          await tree.set(n as NodeData);
        }
      }

      return treeOpsResult;
    } finally {
      vm.dispose();
      runtime.dispose();
    }
  };

  // No register() — don't cache permanently. Re-evaluate from tree each time.
  // This ensures source changes take effect without server restart.
  console.warn(`[actions] loading dynamic action "${action}" for "${type}" from ${typePath}`);
  return fn;
}

async function resolveActionHandler(
  tree: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
): Promise<ResolvedAction> {
  const node = await tree.get(path);
  if (!node) throw new OpError('NOT_FOUND', `Node not found: ${path}`);

  const [comp, fieldKey] = getComponentField(node, componentType ?? 't.any', componentKey) ?? [];
  if (!isComponent(comp)) throw new OpError('NOT_FOUND', `Component "${componentKey ?? componentType}" not found on ${path}`);

  const type = comp.$type;

  let deps: ResolvedDeps = await _collectDeps(node, fieldKey!, action, tree);

  let handler = resolve(type, `action:${action}`);

  // Fallback: try loading dynamic action from type definition node
  if (!handler) handler = await loadDynamicAction(tree, type, action);
  if (!handler) throw new OpError('BAD_REQUEST', `No action "${action}" for type "${type}"`);

  return { node, handler, type, comp, deps, fieldKey };
}

// ── executeAction: mutating action with Immer draft + patch collection ──
// Patches attached as $patches for subscription layer (CDC Matrix in sub.ts).
// Pure actions (no state changes) skip persist — patches.length === 0.
// Per-path lock prevents lost updates from concurrent mutations on the same node.
const lockAction = createPathLock();

export async function executeAction<T = unknown>(
  tree: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
  data?: unknown,
  opts?: { userId?: string | null },
): Promise<T> {
  return lockAction(path, async () => {
  const { node, handler, type, deps, fieldKey } = await resolveActionHandler(
    tree, path, componentType, componentKey, action,
  );

  // Pre/post condition checking (Design by Contract)
  const schemaHandler = resolve(type, 'schema');
  const methodSchema = schemaHandler?.()?.methods?.[action];
  validateActionArgs(type, action, data);

  const preFields: string[] = methodSchema?.pre ?? [];
  const postFields: string[] = methodSchema?.post ?? [];
  const target = fieldKey ? node[fieldKey] as Record<string, unknown> : node as Record<string, unknown>;

  for (const f of preFields) {
    const v = target[f];
    if (v === undefined || v === null || v === '' || v === 0) {
      console.warn(`[pre] ${type}.${action}: field "${f}" is empty`);
    }
  }

  const postSnap = Object.fromEntries(postFields.map(f => [f, target[f]]));

  const draft = createDraft(node);
  // comp must be the draft version so Immer captures mutations via `this.*`
  const dc = fieldKey ? draft[fieldKey] : undefined;
  const draftComp = isComponent(dc) ? dc as ComponentData : undefined;

  // Remap sibling deps to draft so Immer captures mutations through deps too
  for (const key of Object.keys(deps)) {
    if (deps[key] === node[key]) {
      deps[key] = draft[key] as ComponentData;
    }
  }

  const nc = serverNodeHandle(tree);
  const actx: ActionCtx = { node: draft, comp: draftComp, deps, tree, signal: AbortSignal.timeout(ACTION_TIMEOUT), nc, userId: opts?.userId };
  const result = await handler(actx, data ?? {});

  let patches: Patch[] = [];
  const nextNode = finishDraft(draft, (p) => { patches = p });

  const postTarget = fieldKey ? nextNode[fieldKey] as Record<string, unknown> : nextNode as Record<string, unknown>;
  for (const f of postFields) {
    if (postTarget[f] === postSnap[f]) {
      console.warn(`[post] ${type}.${action}: field "${f}" unchanged`);
    }
  }

  if (patches.length > 0) {
    const ops = immerToPatchOps(patches);
    await tree.patch(node.$path, ops);
  }
  return result as T;
  }); // lockAction
}

// ── executeStream: generator action — yields multiple values, no Immer draft ──
// Generator actions persist via tree.set() directly inside the generator body.

export async function* executeStream(
  tree: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
  data?: unknown,
  signal?: AbortSignal,
  opts?: { userId?: string | null },
): AsyncGenerator<unknown> {
  const { node, handler, type, comp, deps } = await resolveActionHandler(
    tree, path, componentType, componentKey, action,
  );

  validateActionArgs(type, action, data);

  // comp is already node[fieldKey] from resolution — no Immer draft needed for generators
  const nc = serverNodeHandle(tree);
  const actx: ActionCtx = { node, comp, deps, tree, signal: signal ?? AbortSignal.timeout(STREAM_TIMEOUT), nc, userId: opts?.userId };
  const result = handler(actx, data ?? {});
  if (!result || typeof (result as any)[Symbol.asyncIterator] !== 'function')
    throw new OpError('BAD_REQUEST', `Action "${action}" is not a generator`);
  yield* result as AsyncIterable<unknown>;
}

// ── setComponent: single component update with OCC ──

export async function setComponent(
  tree: Tree,
  path: string,
  name: string,
  data: Record<string, unknown>,
  rev?: number,
): Promise<void> {
  const node = await tree.get(path);
  if (!node) throw new OpError('NOT_FOUND', `Node not found: ${path}`);

  if (rev != null && node.$rev != null && rev !== node.$rev)
    throw new OpError('CONFLICT', `Stale revision: expected ${rev}, got ${node.$rev}`);

  await tree.set({ ...node, [name]: data });
}

// ── applyTemplate: copy template children to target path ──

export async function applyTemplate(
  tree: Tree,
  templatePath: string,
  targetPath: string,
): Promise<{ applied: string; blocks: number }> {
  const tmpl = await tree.get(templatePath);
  if (!tmpl) throw new OpError('NOT_FOUND', `Template not found: ${templatePath}`);

  const { items: blocks } = await tree.getChildren(templatePath);
  const { items: existing } = await tree.getChildren(targetPath);

  // Snapshot existing children for rollback
  const snapshot = existing.map(c => structuredClone(c));

  // Phase 1: Write new children first (crash here → old + partial new, no data loss)
  const written: string[] = [];
  try {
    for (const block of blocks) {
      const bname = block.$path.slice(block.$path.lastIndexOf('/') + 1);
      const bpath = targetPath === '/' ? `/${bname}` : `${targetPath}/${bname}`;
      const { $rev, ...rest } = block;
      await tree.set({ ...rest, $path: bpath });
      written.push(bpath);
    }
  } catch (err) {
    // Rollback: remove partially written new children, restore originals
    for (const wp of written) await tree.remove(wp).catch(() => {});
    for (const orig of snapshot) await tree.set(orig).catch(() => {});
    throw err;
  }

  // Phase 2: Delete old children not in new set (crash here → duplicates, no loss)
  const newPaths = new Set(written);
  for (const child of existing) {
    if (!newPaths.has(child.$path)) {
      await tree.remove(child.$path);
    }
  }

  return { applied: tmpl.$path, blocks: blocks.length };
}

// ── Generic patch action — deep merge data into node (Immer draft) ──
// Registered on 'default' so every type inherits it via resolve fallback.
// Guards $ fields. Deep-merges objects, replaces arrays/primitives.

function deepAssign(target: any, source: Record<string, unknown>) {
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('$') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)
      && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepAssign(target[k], v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

export function registerBuiltinActions() {
  register('default', 'action:patch', (ctx: ActionCtx, data: unknown) => {
    if (!data || typeof data !== 'object') throw new OpError('BAD_REQUEST', 'patch: data must be an object');
    deepAssign(ctx.node, data as Record<string, unknown>);
  });
}

registerBuiltinActions();
