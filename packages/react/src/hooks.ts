// Treenity Hooks — reactive node access
// usePath:     universal reactive read (URI or typed proxy)
// useChildren: reactive children list
// set:         persist node (optimistic + server)
// execute:     action caller
// watch:       universal async generator

import { type Class, getComp, type TypeProxy } from '@treenity/core/comp';
import { getComponent, type NodeData, normalizeType } from '@treenity/core/core';
import { deriveURI, parseURI } from '@treenity/core/uri';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
    useCallback((cb: () => void) => (path ? cache.subscribePath(path, cb) : () => {}), [path]),
    useCallback(() => (path ? cache.get(path) : undefined), [path]),
  );

  useEffect(() => {
    if (!path) return;
    trpc.get.query({ path, watch: !opts?.once }).then((n: unknown) => {
      if (n) cache.put(n as NodeData);
    });
  }, [path, opts?.once]);

  return useMemo(() => {
    if (cls && path) return makeProxy(path, cls, node, key);
    return parsed ? deriveURI<T>(node, parsed) : node;
  }, [node, cls, key, path, parsed?.key, parsed?.field]);
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

    if (!cache.has(parentPath) && parentPath !== '/') {
      trpc.get.query({ path: parentPath }).then(n => {
        if (n) cache.put(n as NodeData);
      });
    }

    trpc.getChildren
      .query({ path: parentPath, limit: opts?.limit, watch: opts?.watch, watchNew: opts?.watchNew })
      .then((result: any) => cache.putMany(result.items as NodeData[], parentPath));
  }, [parentPath, gen, opts?.limit, opts?.watch, opts?.watchNew]);

  return useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildren(parentPath, cb), [parentPath]),
    useCallback(() => cache.getChildren(parentPath), [parentPath]),
  );
}

// ── set: optimistic update + server persist ──

export async function set(next: NodeData) {
  cache.put(next);
  await tree.set(next);
  const fresh = await tree.get(next.$path);
  if (fresh) cache.put(fresh);
}

// ── execute: action caller ──

export const execute = (
  path: string, action: string, data?: unknown, type?: string, key?: string,
) => trpc.execute.mutate({ path, type, key, action, data });

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

// ── Internals ──

const AsyncGenFn = Object.getPrototypeOf(async function* () {}).constructor;

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
    ? (key ? getComponent(node, key) : getComp(node, cls))
    : undefined;

  return new Proxy(comp ?? {}, {
    get: (_target, prop: string) => {
      const fn = (cls.prototype as any)[prop];
      if (typeof fn === 'function') {
        if (fn instanceof AsyncGenFn)
          return (data?: unknown) => streamToAsyncIterable({ path, type, key, action: prop, data });
        return (data?: unknown) => trpc.execute.mutate({ path, type, key, action: prop, data });
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
