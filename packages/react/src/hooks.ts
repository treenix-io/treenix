// Treenity Hooks — reactive node access
// usePath:     universal reactive read (URI or typed proxy)
// useChildren: reactive children list
// set:         persist node (optimistic + server)
// execute:     action caller
// watch:       universal async generator

import { getComponent, type NodeData, normalizeType, resolve } from '@treenity/core';
import { type Class, type TypeProxy } from '@treenity/core/comp';
import { deriveURI, parseURI } from '@treenity/core/uri';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import * as cache from './cache';
import { tree } from './client';
import { trpc } from './trpc';

// ── Navigation context — shell provides, views consume ──

export type NavigateFn = (path: string) => void;
const NavigateCtx = createContext<NavigateFn | null>(null);
export const NavigateProvider = NavigateCtx.Provider;

export function useNavigate(): NavigateFn {
  const nav = useContext(NavigateCtx);
  if (!nav) throw new Error('useNavigate: no NavigateProvider');
  return nav;
}

// ── usePath: universal reactive hook ──
// URI mode:   usePath('/path#comp.field')      → derived value
// Typed mode: usePath('/path', MyClass)        → TypeProxy<T>
// Options:    usePath('/path', { once: true })  → no server watch

type PathOpts = { once?: boolean };

export function usePath<T = NodeData>(uri: string | null, opts?: PathOpts): T | undefined;
export function usePath<T extends object>(path: string, cls: Class<T>, key?: string): TypeProxy<T>;
export function usePath<T extends object>(
  pathOrUri: string | null,
  clsOrOpts?: Class<T> | PathOpts,
  key?: string,
) {
  const isTyped = typeof clsOrOpts === 'function';
  const cls = isTyped ? clsOrOpts as Class<T> : undefined;
  const opts = isTyped ? undefined : clsOrOpts as PathOpts | undefined;

  const parsed = useMemo(
    () => pathOrUri && !isTyped ? parseURI(pathOrUri) : null,
    [pathOrUri, isTyped],
  );
  const path = isTyped ? pathOrUri : (parsed?.path ?? null);

  const node = useSyncExternalStore(
    useCallback((cb: () => void) => (path ? cache.subscribePath(path, cb) : () => { }), [path]),
    useCallback(() => (path ? cache.get(path) : undefined), [path]),
  );

  useEffect(() => {
    if (!path) return;
    debugPath(path, 'usePath');
    trpc.get.query({ path, watch: !opts?.once }).then((n: unknown) => {
      if (n) cache.put(n as NodeData);
    });
  }, [path, opts?.once]);

  return useMemo(() => {
    if (cls && path) return makeProxy(path, cls, node, key);
    return parsed ? deriveURI<T>(node, parsed) : node;
  }, [node, cls, key, path, parsed?.key, parsed?.field]);
}

function debugPath(path: string, hook: string) {
  if (path.includes('//')) {
    console.error(`[hooks] double slash in ${hook}: ${JSON.stringify(path)}`, new Error('stack'));
  }
}

// ── useChildren: reactive children list ──

type WatchOpts = { watch?: boolean; watchNew?: boolean; limit?: number };

export function useChildren(parentPath: string, opts?: WatchOpts) {
  const loaded = useRef<string | null>(null);
  const gen = useSyncExternalStore(cache.subscribeSSEGen, cache.getSSEGen);
  const prevGen = useRef(gen);

  useEffect(() => {
    const reconnected = prevGen.current !== gen;
    if (loaded.current === parentPath && !reconnected) return;
    loaded.current = parentPath;
    prevGen.current = gen;

    debugPath(parentPath, 'useChildren');

    if (!cache.has(parentPath) && parentPath !== '/') {
      trpc.get.query({ path: parentPath }).then(n => {
        if (n) cache.put(n as NodeData);
      });
    }

    trpc.getChildren
      .query({ path: parentPath, limit: opts?.limit, watch: opts?.watch, watchNew: opts?.watchNew })
      .then((result: any) => {
        if (result.truncated) console.warn(`[tree] Children of ${parentPath} truncated — results may be incomplete`);
        cache.putMany(result.items as NodeData[], parentPath);
      });
  }, [parentPath, gen, opts?.limit, opts?.watch, opts?.watchNew]);

  return useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildren(parentPath, cb), [parentPath]),
    useCallback(() => cache.getChildren(parentPath), [parentPath]),
  );
}

// ── set: optimistic update + server persist ──

export async function set(next: NodeData) {
  const prev = cache.get(next.$path);
  cache.put(next);
  try {
    await tree.set(next);
    const fresh = await tree.get(next.$path);
    if (fresh) cache.put(fresh);
  } catch (err) {
    // F15: rollback optimistic cache on server reject (validation, ACL, OCC)
    if (prev) cache.put(prev); else cache.remove(next.$path);
    throw err;
  }
}

// ── execute: action caller ──

export const execute = (
  pathOrUri: string, action: string, data?: unknown, type?: string, key?: string,
) => {
  let path = pathOrUri;
  if (!key && pathOrUri.includes('#')) {
    const parsed = parseURI(pathOrUri);
    path = parsed.path;
    key = parsed.key;
  }

  // Optimistic: resolve class from cache + registry, predict locally
  const cached = cache.get(path);
  if (cached) {
    const compType = type ?? cached.$type;
    const cls = resolve(compType, 'class');
    if (cls) {
      const fn = cls.prototype?.[action];
      if (fn) predictOptimistic(path, cls, key, fn, data);
    }
  }

  return trpc.execute.mutate({ path, type, key, action, data });
};

// ── useCanWrite: ACL-based write permission check ──

const W = 2;
const permCache = new Map<string, { perm: number; ts: number }>();
const PERM_TTL = 30_000; // 30s cache

export function useCanWrite(path: string | null): boolean {
  const [perm, setPerm] = useState<number>(0);

  useEffect(() => {
    if (!path) return;
    const cached = permCache.get(path);
    if (cached && Date.now() - cached.ts < PERM_TTL) {
      setPerm(cached.perm);
      return;
    }
    trpc.getPerm.query({ path }).then((p) => {
      permCache.set(path, { perm: p, ts: Date.now() });
      setPerm(p);
    }).catch(() => setPerm(0));
  }, [path]);

  return (perm & W) !== 0;
}

// ── useAutoSave: throttled auto-persist for editable views ──
// First save fires after 500ms (responsive), subsequent saves throttled to 2s.
// Returns [localData, setField, dirty] — local updates are instant, server writes are batched.

// TODO: check why unused
export function useAutoSave(node: NodeData) {
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const lastSaveRef = useRef(0);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const flush = useCallback(async () => {
    if (savingRef.current) { pendingRef.current = true; return; }
    if (!dirtyRef.current) return;
    savingRef.current = true;
    try {
      const merged = { ...nodeRef.current, ...local };
      delete merged.$rev; // skip OCC — force-write
      await set(merged);
      dirtyRef.current = false;
      lastSaveRef.current = Date.now();
    } catch (e) {
      console.error('[autoSave] failed:', e);
    } finally {
      savingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        flush();
      }
    }
  }, [local]);

  const setField = useCallback((field: string, value: unknown) => {
    setLocal(prev => ({ ...prev, [field]: value }));
    dirtyRef.current = true;

    if (timerRef.current) clearTimeout(timerRef.current);
    const elapsed = Date.now() - lastSaveRef.current;
    const delay = elapsed > 2000 ? 500 : 2000; // first batch fast, then throttle
    timerRef.current = setTimeout(() => { timerRef.current = null; flush(); }, delay);
  }, [flush]);

  // Flush on unmount
  useEffect(() => () => {
    if (timerRef.current) { clearTimeout(timerRef.current); flush(); }
  }, [flush]);

  // Reset local on node path change
  useEffect(() => { setLocal({}); dirtyRef.current = false; }, [node.$path]);

  const merged = useMemo(() => ({ ...node, ...local }), [node, local]);

  return [merged, setField, dirtyRef.current] as const;
}

// ── Internals ──

const AsyncGenFn = Object.getPrototypeOf(async function* () { }).constructor;
const AsyncFn = Object.getPrototypeOf(async function () { }).constructor;

/** Optimistic prediction: run a sync method locally on a cloned cached node */
export function predictOptimistic<T extends object>(
  path: string, cls: Class<T>, key: string | undefined,
  fn: Function, data: unknown,
): void {
  if (fn instanceof AsyncFn) return;

  const cached = cache.get(path);
  if (!cached) return;

  try {
    const draft = structuredClone(cached);
    const target = getComponent(draft, cls, key);
    if (!target) return;

    fn.call(target, data);
    cache.put(draft);
  } catch { /* prediction failed — server-only */ }
}

function streamToAsyncIterable<T>(
  input: { path: string; type?: string; key?: string; action: string; data?: unknown },
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = [];
      let notify: (() => void) | null = null;
      let done = false;
      let error: unknown = null;

      const sub = trpc.streamAction.subscribe(input, {
        onData(item) { queue.push(item as T); notify?.(); notify = null; },
        onComplete() { done = true; notify?.(); notify = null; },
        onError(err) { error = err; done = true; notify?.(); notify = null; },
      });

      return {
        async next(): Promise<IteratorResult<T>> {
          while (!queue.length && !done)
            await new Promise<void>(r => { notify = r; });
          if (error) throw error;
          if (queue.length) return { value: queue.shift()!, done: false };
          return { value: undefined as any, done: true };
        },
        async return(): Promise<IteratorResult<T>> {
          sub.unsubscribe();
          done = true; notify?.(); notify = null;
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

function makeProxy<T extends object>(
  path: string, cls: Class<T>, node: NodeData | undefined, key?: string,
): TypeProxy<T> {
  const type = normalizeType(cls);
  const comp = node
    ? (key ? getComponent(node, key) : getComponent(node, cls))
    : undefined;

  return new Proxy(comp ?? {}, {
    get: (_target, prop: string) => {
      const fn = (cls.prototype as any)[prop];
      if (typeof fn === 'function') {
        if (fn instanceof AsyncGenFn)
          return (data?: unknown) => streamToAsyncIterable({ path, type, key, action: prop, data });

        return (data?: unknown) => {
          predictOptimistic(path, cls, key, fn, data);
          return trpc.execute.mutate({ path, type, key, action: prop, data });
        };
      }
      return (comp as any)?.[prop];
    },
  }) as TypeProxy<T>;
}

// ── watch: universal async generator ──

export async function* watch<T = unknown>(uri: string): AsyncGenerator<T> {
  const parsed = parseURI(uri);

  if (parsed.action) {
    yield* streamToAsyncIterable<T>({
      path: parsed.path,
      key: parsed.key,
      action: parsed.action,
      data: parsed.data,
    });
    return;
  }

  const { path } = parsed;
  const initial = await trpc.get.query({ path, watch: true });
  if (initial) cache.put(initial as NodeData);

  let resolve: (() => void) | null = null;
  const unsub = cache.subscribePath(path, () => { resolve?.(); resolve = null; });

  try {
    yield deriveURI<T>(cache.get(path), parsed) as T;

    while (true) {
      await new Promise<void>(r => { resolve = r; });
      yield deriveURI<T>(cache.get(path), parsed) as T;
    }
  } finally {
    unsub();
  }
}
