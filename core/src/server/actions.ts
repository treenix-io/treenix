// Treenity Actions — Layer 4
// Server-specific: ActionCtx, SchemaHandler, client proxy
// Component registration lives in @/comp

import { chain, type Chain } from '#chain';
import { Class, type TypeProxy } from '#comp';
import { makeTypedProxy, type ExecuteFn, type StreamFn } from '#comp/handle';
import { collectDeps as _collectDeps, type ResolvedDeps } from '#comp/needs';
import { type ComponentData, getComponentField, isComponent, type NodeData, register, resolve } from '#core';
import { type Tree } from '#tree';
import { createDraft, enablePatches, finishDraft, type Patch } from 'immer';
import { OpError } from './errors';

export type NodeHandle = ReturnType<typeof serverNodeHandle>;

export type ActionCtx = {
  node: NodeData;
  store: Tree;
  signal: AbortSignal;
  /** Typed client for cross-node action calls: ctx.nc(path).get(Type).method(data) */
  nc: NodeHandle;
  comp?: ComponentData;
  deps?: ResolvedDeps;
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
// Usage: const nc = serverNodeHandle(store); await nc(path).get(MyComp).myMethod();
export function serverNodeHandle(store: Tree) {
  return createNodeHandle(
    (input) => executeAction(store, input.path, input.type, input.key, input.action, input.data),
    (input) => executeStream(store, input.path, input.type, input.key, input.action, input.data),
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

// Dynamic actions: load from /sys/types/{ns}/{name} node's `actions` component.
// Code is compiled with new Function, registered for future calls.
// Format: actions.{name} = "const node = ...; return result;"  (async function body)
async function loadDynamicAction(
  store: Tree, type: string, action: string,
): Promise<((ctx: ActionCtx, data: unknown) => unknown) | null> {
  if (!type.includes('.')) return null;

  const typePath = `/sys/types/${type.replace(/\./g, '/')}`;
  const typeNode = await store.get(typePath);
  const actionCode = (typeNode as any)?.actions?.[action];
  if (!actionCode || typeof actionCode !== 'string') return null;

  try {
    const fn = new Function('ctx', 'data', `return (async () => { ${actionCode} })()`) as
      (ctx: ActionCtx, data: unknown) => unknown;
    register(type, `action:${action}`, fn);
    console.log(`[uix] loaded dynamic action "${action}" for "${type}"`);
    return fn;
  } catch (err: any) {
    console.warn(`[uix] failed to compile action "${action}" for "${type}":`, err.message);
    return null;
  }
}

async function resolveActionHandler(
  store: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
): Promise<ResolvedAction> {
  const node = await store.get(path);
  if (!node) throw new OpError('NOT_FOUND', `Node not found: ${path}`);

  const [comp, fieldKey] = getComponentField(node, componentType ?? 't.any', componentKey) ?? [];
  if (!isComponent(comp)) throw new OpError('NOT_FOUND', `Component "${componentKey ?? componentType}" not found on ${path}`);

  const type = comp.$type;

  let deps: ResolvedDeps = await _collectDeps(node, fieldKey!, action, store);

  let handler = resolve(comp, `action:${action}`);

  // Fallback: try loading dynamic action from type definition node
  if (!handler) handler = await loadDynamicAction(store, type, action);
  if (!handler) throw new OpError('BAD_REQUEST', `No action "${action}" for type "${type}"`);

  return { node, handler, type, comp, deps, fieldKey };
}

// ── executeAction: mutating action with Immer draft + patch collection ──
// Patches attached as $patches for subscription layer (CDC Matrix in sub.ts).
// Pure actions (no state changes) skip persist — patches.length === 0.

export async function executeAction(
  store: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
  data?: unknown,
): Promise<unknown> {
  const { node, handler, type, deps, fieldKey } = await resolveActionHandler(
    store, path, componentType, componentKey, action,
  );

  // Pre/post condition checking (Design by Contract)
  const schemaHandler = resolve(type, 'schema') as (() => any) | null;
  const methodSchema = schemaHandler?.()?.methods?.[action];
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
  const nc = serverNodeHandle(store);
  const actx: ActionCtx = { node: draft, comp: draftComp, deps, store, signal: AbortSignal.timeout(ACTION_TIMEOUT), nc };
  const result = await handler(actx, data ?? {});

  let patches: Patch[] = [];
  const nextNode = finishDraft(draft, (p) => { patches = p });

  const postTarget = fieldKey ? nextNode[fieldKey] as Record<string, unknown> : nextNode as Record<string, unknown>;
  for (const f of postFields) {
    if (postTarget[f] === postSnap[f]) {
      console.warn(`[post] ${type}.${action}: field "${f}" unchanged`);
    }
  }

  if (patches.length > 0) await store.set({ ...nextNode, $patches: patches } as NodeData);
  return result;
}

// ── executeStream: generator action — yields multiple values, no Immer draft ──
// Generator actions persist via store.set() directly inside the generator body.

export async function* executeStream(
  store: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
  data?: unknown,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const { node, handler, comp, deps } = await resolveActionHandler(
    store, path, componentType, componentKey, action,
  );
  // comp is already node[fieldKey] from resolution — no Immer draft needed for generators
  const nc = serverNodeHandle(store);
  const actx: ActionCtx = { node, comp, deps, store, signal: signal ?? AbortSignal.timeout(STREAM_TIMEOUT), nc };
  const result = handler(actx, data ?? {});
  if (!result || typeof (result as any)[Symbol.asyncIterator] !== 'function')
    throw new OpError('BAD_REQUEST', `Action "${action}" is not a generator`);
  yield* result as AsyncIterable<unknown>;
}

// ── setComponent: single component update with OCC ──

export async function setComponent(
  store: Tree,
  path: string,
  name: string,
  data: Record<string, unknown>,
  rev?: number,
): Promise<void> {
  const node = await store.get(path);
  if (!node) throw new OpError('NOT_FOUND', `Node not found: ${path}`);

  if (rev != null && node.$rev != null && rev !== node.$rev)
    throw new OpError('CONFLICT', `Stale revision: expected ${rev}, got ${node.$rev}`);

  node[name] = data;
  await store.set(node);
}

// ── applyTemplate: copy template children to target path ──

export async function applyTemplate(
  store: Tree,
  templatePath: string,
  targetPath: string,
): Promise<{ applied: string; blocks: number }> {
  const tmpl = await store.get(templatePath);
  if (!tmpl) throw new OpError('NOT_FOUND', `Template not found: ${templatePath}`);

  const { items: blocks } = await store.getChildren(templatePath);
  const { items: existing } = await store.getChildren(targetPath);

  for (const child of existing) await store.remove(child.$path);

  for (const block of blocks) {
    const bname = block.$path.slice(block.$path.lastIndexOf('/') + 1);
    const bpath = targetPath === '/' ? `/${bname}` : `${targetPath}/${bname}`;
    const { $rev, ...rest } = block;
    await store.set({ ...rest, $path: bpath });
  }

  return { applied: tmpl.$path, blocks: blocks.length };
}

// ── Generic patch action — deep merge data into node (Immer draft) ──
// Registered on 'default' so every type inherits it via resolve fallback.
// Guards $ fields. Deep-merges objects, replaces arrays/primitives.

function deepAssign(target: any, source: Record<string, unknown>) {
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('$')) continue;
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
