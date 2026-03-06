import { type Class, ComponentData, normalizeType, type TypeId } from './component';
import { ContextHandler, Handler } from './context';

const registry = new Map<string, Handler>();
const metaRegistry = new Map<string, Record<string, unknown>>();

// ── Registry subscription — lets React re-render when handlers change ──
let version = 0;
const listeners = new Set<() => void>();
function bump() {
  version++;
  listeners.forEach(cb => cb());
}
export function subscribeRegistry(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getRegistryVersion() { return version; }

function key(type: string, context: string): string {
  return `${type}@${context}`;
}

export function register<C extends string>(type: string, context: C, handler: ContextHandler<C>, meta?: Record<string, unknown>): void;
export function register<T, C extends string>(type: Class<T>, context: C, handler: ContextHandler<C, T>, meta?: Record<string, unknown>): void;
export function register(type: TypeId, context: string, handler: Handler, meta?: Record<string, unknown>): void {
  const k = key(normalizeType(type), context);
  // Sealed: no overrides. In dev (HMR) modules re-execute, so we allow silent replace.
  // In production, duplicate register = bug, caught by tests.
  if (registry.has(k)) return;
  registry.set(k, handler as Handler);
  if (meta) metaRegistry.set(k, meta);
  bump();
}

export function getMeta(type: TypeId, context: string): Record<string, unknown> | null {
  return metaRegistry.get(key(normalizeType(type), context)) ?? null;
}

export function resolve<C extends string>(type: TypeId, context: C, _notifyMiss = true): ContextHandler<C> | null {
  const n = normalizeType(type);
  const exact = registry.get(key(n, context));
  if (exact) return exact as ContextHandler<C>;

  // Notify miss BEFORE default fallback — async loaders (UIX) start fetching,
  // register when done, bump triggers re-render → next resolve finds exact match
  if (_notifyMiss) missResolvers.get(context)?.(n);

  const def = registry.get(key(normalizeType('default'), context));
  if (def) return def as ContextHandler<C>;

  // fallback: strip last segment ("react:compact" → "react")
  const sep = context.lastIndexOf(':');
  if (sep > 0) return resolve(type, context.slice(0, sep) as C, false);

  return null;
}

// Returns the exact registered handler, no fallback, no miss notification
export function resolveExact<C extends string>(type: TypeId, context: C): ContextHandler<C> | null {
  return (registry.get(key(normalizeType(type), context)) ?? null) as ContextHandler<C> | null;
}

export function hasMissResolver(context: string): boolean {
  return missResolvers.has(context);
}

export function unregister(type: string, context: string): boolean {
  const k = key(normalizeType(type), context);
  metaRegistry.delete(k);
  const deleted = registry.delete(k);
  if (deleted) bump();
  return deleted;
}

export function mapRegistry<T>(fn: (type: string, context: string) => T | undefined): T[] {
  const result: T[] = [];
  for (const k of registry.keys()) {
    const i = k.lastIndexOf('@');
    const v = fn(k.slice(0, i), k.slice(i + 1));
    if (v !== undefined) result.push(v);
  }
  return result;
}

export function getRegisteredTypes(context?: string): string[] {
  return context
    ? mapRegistry((t, c) => c === context ? t : undefined)
    : [...new Set(mapRegistry(t => t))];
}

export function getContextsForType(type: TypeId): string[] {
  const n = normalizeType(type);
  return mapRegistry((t, c) => t === n ? c : undefined);
}

// ── Resolve miss — per-context extension point for dynamic loaders ──
// One resolver per context. UIX uses this for 'react' to lazy-load views from type nodes.
// REVIEW: if more per-context behavior emerges (validate, wrap, fallback), consider
// evolving into defineContext('react', { onMiss, validate, ... }) trait system.
const missResolvers = new Map<string, (type: string) => void>();
export function onResolveMiss(context: string, resolver: (type: string) => void) {
  missResolvers.set(context, resolver);
}

// ── Render (context-aware) ──

export function render(data: ComponentData, context: string, ...args: unknown[]): unknown {
  const handler = resolve(data.$type, context);
  if (!handler) throw new Error(`No handler for type "${data.$type}" in context "${context}"`);
  return handler(data, ...args);
}
