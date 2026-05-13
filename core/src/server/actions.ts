// Treenix Actions — Layer 4
// Server-specific: ActionCtx, SchemaHandler, client proxy
// Component registration lives in @/comp

import { chain, type Chain } from '#chain';
import { Class, type TypeProxy } from '#comp';
import { type ExecuteFn, makeTypedProxy, type StreamFn } from '#comp/handle';
import { collectDeps as _collectDeps, type ResolvedDeps } from '#comp/needs';
import { assertSafeKey, type ComponentData, getComponentField, getMeta, isComponent, type NodeData, register, resolve, safeJsonParse } from '#core';
import { validateValue, type ValidationError } from '#comp/validate';
import { type TypeSchema } from '#schema/types';
import { type PatchOp, type Tree } from '#tree';
import { createDraft, enablePatches, finishDraft, type Patch } from 'immer';
import { createPathLock } from '#util/path-lock';
import { OpError } from '#errors';
import { readonlyProxy, wrapReadOnlyTree } from './readonly-tree';
import { assertCanCall, runWithFrame, type KindFrame } from './kind-stack';

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

// R4-MOUNT-4: shallow walk over a stored type's `schema` field to reject patterns that
// would DoS the validator. Caps cover the worst-case offenders: catastrophic-backtracking
// regex (length + nested-quantifier shape), oversized enums, deeply-nested anyOf/allOf.
const SCHEMA_PATTERN_MAX = 256;
const SCHEMA_DEPTH_MAX = 16;
function assertSafeSchema(schema: unknown, ctx: string, depth = 0): void {
  if (!schema || typeof schema !== 'object') return;
  if (depth > SCHEMA_DEPTH_MAX) throw new OpError('BAD_REQUEST', `${ctx}: schema too deep (max ${SCHEMA_DEPTH_MAX})`);
  if (Array.isArray(schema)) { for (const v of schema) assertSafeSchema(v, ctx, depth + 1); return; }
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'pattern' && typeof v === 'string') {
      if (v.length > SCHEMA_PATTERN_MAX) throw new OpError('BAD_REQUEST', `${ctx}: schema.pattern too long (>${SCHEMA_PATTERN_MAX})`);
      // Reject the classic catastrophic-backtracking shape: nested quantifiers like (a+)+ / (a*)*.
      if (/\([^)]*[+*][^)]*\)[+*]/.test(v)) throw new OpError('BAD_REQUEST', `${ctx}: schema.pattern has nested quantifiers (ReDoS risk)`);
    }
    assertSafeSchema(v, ctx, depth + 1);
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

/** Actor identity + caller-context for audit trails.
 *  - `id` is a stable principal id ('user:kriz', 'agent-workload:r-7f2a', 'system:autostart').
 *  - taskPath/runPath/action/requestId are open metadata: entry points (MCP/tRPC) populate
 *    them from session metadata so audit subscribers can record "who, on which task,
 *    in which run, doing which action, as part of which request". */
export type ActorContext = {
  id: string;
  taskPath?: string;
  runPath?: string;
  action?: string;
  requestId?: string;
};

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
  /** Caller's claims (e.g. 'admins', 'authenticated'). Empty/undefined for system. */
  claims?: string[];
  /** Actor metadata (audit trail). See ActorContext. */
  actor?: ActorContext;
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

// Action timeout: env-configurable, default 10s.
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT) || 10_000;
const STREAM_TIMEOUT = Number(process.env.STREAM_TIMEOUT) || 600_000;

function withActionTimeout<T>(label: string, signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`${label} timed out after ${ACTION_TIMEOUT}ms`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${label} timed out after ${ACTION_TIMEOUT}ms`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

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
  // Strict: only nodes with $type === 'type' are valid type definitions. Without this an attacker
  // who can write any node at /sys/types/* — even one with arbitrary $type — could plant
  // executable `actions` and a poisoned `schema` (the latter disables validateActionArgs globally).
  if (!typeNode || typeNode.$type !== 'type') return null;
  const actionCode = (typeNode as any)?.actions?.[action];
  if (!actionCode || typeof actionCode !== 'string') return null;

  // Register schema from type node's `schema` field
  if (!resolve(type, 'schema')) {
    const nodeSchema = (typeNode as Record<string, unknown>).schema;
    if (!nodeSchema || typeof nodeSchema !== 'object') return null;
    // R4-MOUNT-4: cap regex `pattern` complexity. F6 made /sys/types admin-only-write,
    // but admin typo / malicious mod can plant `pattern: '(a+)+$'` (catastrophic backtracking)
    // and DoS the single-process tenant on every action invocation.
    assertSafeSchema(nodeSchema as Record<string, unknown>, type);
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
        try { treeWrites.push({ node: safeJsonParse(nj) }); } catch {}
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
          // Route through ctx.tree (read-only facade applies when parent action's kind = 'read').
          await ctx.tree.set(n as NodeData);
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
  // Mask FORBIDDEN as NOT_FOUND on execute — security: don't leak existence
  // of paths the caller can't read. (tree.get throws FORBIDDEN on no read perm.)
  const node = await tree.get(path).catch((e: any) => {
    if (e?.code === 'FORBIDDEN') throw new OpError('NOT_FOUND', `Node not found: ${path}`);
    throw e;
  });
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
  opts?: { userId?: string | null; claims?: string[]; actor?: ActorContext },
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

  // Kind enforcement: default 'write' preserves existing semantics.
  // Lookup: registry-meta (programmatic register opts) → schema (JSDoc) → fallback 'write'.
  // 'read' skips Immer draft entirely and gives the handler a readonly proxy of
  // node/comp + a read-only tree facade. Any assignment (`ctx.node.x = …`,
  // `this.x = …`, `ctx.tree.set(…)`) throws KIND_VIOLATION immediately.
  const actionMeta = getMeta(type, `action:${action}`);
  const metaKind = actionMeta?.kind as 'read' | 'write' | undefined;
  const metaIo = actionMeta?.io as boolean | undefined;
  const kind: 'read' | 'write' = metaKind ?? methodSchema?.kind ?? 'write';
  const io: boolean = metaIo ?? methodSchema?.io ?? false;

  // Stack-based propagation check — throws BEFORE we touch the handler so
  // nested invocations don't produce partial side effects.
  assertCanCall({ kind, io });
  const frame: KindFrame = { kind, io, path, action };

  let draft: NodeData | null = null;
  let nodeForCtx: NodeData;
  let compForCtx: ComponentData | undefined;

  if (kind === 'read') {
    nodeForCtx = readonlyProxy(node);
    const rc = fieldKey ? node[fieldKey] : undefined;
    compForCtx = isComponent(rc) ? readonlyProxy(rc as ComponentData) : undefined;
  } else {
    draft = createDraft(node);
    const dc = fieldKey ? draft[fieldKey] : undefined;
    nodeForCtx = draft;
    compForCtx = isComponent(dc) ? dc as ComponentData : undefined;
    // Remap sibling deps to draft so Immer captures mutations through deps too
    for (const key of Object.keys(deps)) {
      if (deps[key] === node[key]) {
        deps[key] = draft[key] as ComponentData;
      }
    }
  }

  const treeForCtx = kind === 'read' ? wrapReadOnlyTree(tree) : tree;
  const nc = serverNodeHandle(treeForCtx);
  const signal = AbortSignal.timeout(ACTION_TIMEOUT);
  const actx: ActionCtx = { node: nodeForCtx, comp: compForCtx, deps, tree: treeForCtx, signal, nc, userId: opts?.userId, claims: opts?.claims, actor: opts?.actor };
  const result = await runWithFrame(frame, () =>
    withActionTimeout(`${type}.${action}`, signal, Promise.resolve(handler(actx, data ?? {}))),
  );

  let patches: Patch[] = [];
  if (draft) {
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
  opts?: { userId?: string | null; claims?: string[]; actor?: ActorContext },
): AsyncGenerator<unknown> {
  const { node, handler, type, comp, deps } = await resolveActionHandler(
    tree, path, componentType, componentKey, action,
  );

  validateActionArgs(type, action, data);

  // comp is already node[fieldKey] from resolution — no Immer draft needed for generators
  const nc = serverNodeHandle(tree);
  const actx: ActionCtx = { node, comp, deps, tree, signal: signal ?? AbortSignal.timeout(STREAM_TIMEOUT), nc, userId: opts?.userId, claims: opts?.claims, actor: opts?.actor };
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
    // R4-MOUNT-1: rollback failures must propagate. Silent .catch swallows violate the
    // "fail loud" rule — partial-rollback corruption with no caller-visible signal is the
    // worst possible outcome. Collect rollback failures and throw an aggregate alongside the
    // original cause so operators see both.
    const rollbackErrs: unknown[] = [];
    for (const wp of written) {
      try { await tree.remove(wp); } catch (e) { rollbackErrs.push(e); }
    }
    for (const orig of snapshot) {
      try { await tree.set(orig); } catch (e) { rollbackErrs.push(e); }
    }
    if (rollbackErrs.length) {
      const rbMsgs = rollbackErrs.map(e => (e as Error)?.message ?? String(e)).join('; ');
      throw new OpError('CONFLICT',
        `applyTemplate rollback failed (${rollbackErrs.length} error(s) [${rbMsgs}]) after primary error: ${(err as Error)?.message ?? String(err)}`);
    }
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
    if (k.startsWith('$')) continue;
    assertSafeKey(k);
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
