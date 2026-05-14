import { type Class, ComponentData, normalizeType, type TypeId } from './component';
import { ContextHandler, Handler } from './context';

type Entry = { handler: Handler; meta?: Record<string, unknown> };

// Single source of truth: type → context → entry.
// Stored on globalThis so multiple @treenx/core module instances (e.g. dist loaded
// by plain Node + src loaded by tsx in the same process) share one registry.
// Without this, registerType() in a project mod (src) lands in a different Map
// than the trpc dispatcher (dist) — actions vanish at execute time.
type RegistryShared = {
  registry: Map<string, Map<string, Entry>>;
  listeners: Set<() => void>;
  missResolvers: Map<string, (type: string) => void>;
  version: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __treenxCoreRegistry: RegistryShared | undefined;
}

globalThis.__treenxCoreRegistry ??= {
  registry: new Map(),
  listeners: new Set(),
  missResolvers: new Map(),
  version: 0,
};
const _shared = globalThis.__treenxCoreRegistry;
const registry = _shared.registry;
const listeners = _shared.listeners;

const DEFAULT_TYPE = normalizeType('default');

// ── Registry subscription — lets React re-render when handlers change ──
function bump() {
  _shared.version++;
  listeners.forEach(cb => cb());
}
export function subscribeRegistry(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getRegistryVersion() { return _shared.version; }

function validateContext(context: string): void {
  if (typeof context !== 'string') throw new Error('context must be a string');
  if (!context || !context.trim()) throw new Error('context must be a non-empty string');
}

export function register<C extends string>(type: string, context: C, handler: ContextHandler<C>, meta?: Record<string, unknown>): void;
export function register<T, C extends string>(type: Class<T>, context: C, handler: ContextHandler<C, T>, meta?: Record<string, unknown>): void;
export function register(type: TypeId, context: string, handler: Handler, meta?: Record<string, unknown>): void {
  validateContext(context);
  const t = normalizeType(type);
  let inner = registry.get(t);
  if (!inner) { inner = new Map(); registry.set(t, inner); }
  // Sealed: silent dedup matches HMR re-execution behavior of the prior implementation.
  if (inner.has(context)) return;
  inner.set(context, meta === undefined ? { handler } : { handler, meta });
  bump();
}

export function getMeta(type: TypeId, context: string): Record<string, unknown> | null {
  validateContext(context);
  return registry.get(normalizeType(type))?.get(context)?.meta ?? null;
}

export function resolve<C extends string>(type: TypeId, context: C, _notifyMiss = true): ContextHandler<C> | null {
  validateContext(context);
  const n = normalizeType(type);
  const exact = registry.get(n)?.get(context);
  if (exact) return exact.handler as ContextHandler<C>;

  // Notify miss BEFORE default fallback. Async loaders (UIX) start fetching, register
  // when done, bump() triggers re-render — next resolve() finds exact match. Sync
  // resolvers register inline; we re-check exact below so they take effect in this call.
  if (_notifyMiss) {
    missResolvers.get(context)?.(n);
    const reExact = registry.get(n)?.get(context);
    if (reExact) return reExact.handler as ContextHandler<C>;
  }

  const def = registry.get(DEFAULT_TYPE)?.get(context);
  if (def) return def.handler as ContextHandler<C>;

  // fallback: strip last segment ("react:compact" → "react")
  const sep = context.lastIndexOf(':');
  if (sep > 0) return resolve(type, context.slice(0, sep) as C, false);

  return null;
}

// Returns the exact registered handler — no fallback, no miss notification.
export function resolveExact<C extends string>(type: TypeId, context: C): ContextHandler<C> | null {
  validateContext(context);
  return (registry.get(normalizeType(type))?.get(context)?.handler ?? null) as ContextHandler<C> | null;
}

export function hasMissResolver(context: string): boolean {
  validateContext(context);
  return missResolvers.has(context);
}

export function unregister(type: string, context: string): boolean {
  validateContext(context);
  const t = normalizeType(type);
  const inner = registry.get(t);
  if (!inner?.has(context)) return false;
  inner.delete(context);
  if (!inner.size) registry.delete(t);
  bump();
  return true;
}

/** Atomic replace: unregister(type, ctx) if present, then register. Use this when a
 *  caller must override an existing handler (HMR-style hot reload, inheritance
 *  fallback override). Plain register() keeps its silent-dedup contract for
 *  module-load idempotency. */
export function replaceHandler<C extends string>(type: string, context: C, handler: ContextHandler<C>, meta?: Record<string, unknown>): void;
export function replaceHandler<T, C extends string>(type: Class<T>, context: C, handler: ContextHandler<C, T>, meta?: Record<string, unknown>): void;
export function replaceHandler(type: TypeId, context: string, handler: Handler, meta?: Record<string, unknown>): void {
  unregister(normalizeType(type), context);
  register(type as any, context, handler as any, meta);
}

// Snapshot — callers (e.g. clearRegistry) may unregister during iteration.
export function mapRegistry<T>(fn: (type: string, context: string) => T | undefined): T[] {
  const entries: Array<[string, string]> = [];
  for (const [t, inner] of registry) {
    for (const c of inner.keys()) entries.push([t, c]);
  }
  const result: T[] = [];
  for (const [t, c] of entries) {
    const v = fn(t, c);
    if (v !== undefined) result.push(v);
  }
  return result;
}

export function getRegisteredTypes(context?: string): string[] {
  if (context === undefined) return [...registry.keys()];
  validateContext(context);
  const result: string[] = [];
  for (const [t, inner] of registry) {
    if (inner.has(context)) result.push(t);
  }
  return result;
}

export function getContextsForType(type: TypeId): string[] {
  const inner = registry.get(normalizeType(type));
  return inner ? [...inner.keys()] : [];
}

// ── Resolve miss — per-context extension point for dynamic loaders ──
// One resolver per context. UIX uses this for 'react' to lazy-load views from type nodes.
const missResolvers = _shared.missResolvers;
export function onResolveMiss(context: string, resolver: (type: string) => void) {
  validateContext(context);
  missResolvers.set(context, resolver);
}

// ── Render (context-aware) ──

export function render(data: ComponentData, context: string, ...args: unknown[]): unknown {
  const handler = resolve(data.$type, context);
  if (!handler) throw new Error(`No handler for type "${data.$type}" in context "${context}"`);
  return handler(data, ...args);
}
