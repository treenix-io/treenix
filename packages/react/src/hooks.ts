// Treenix Hooks — reactive node access with Query<T> shape
// usePath:     reactive path read (URI or typed proxy) → Query<T>
// useChildren: reactive children list with pagination → ChildrenQuery
// set:         persist node (optimistic + server)
// execute:     action caller
// watch:       universal async generator

import { getComponent, getMeta, type NodeData, normalizeType, resolve } from '@treenx/core';
import { type Class, getDefaults, type TypeProxy } from '@treenx/core/comp';
import { deriveURI, parseURI } from '@treenx/core/uri';
import { pushOptimistic, rollback } from '#tree/rebase';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import * as cache from '#tree/cache';
import { tree } from '#tree/client';
import { trpc } from '#tree/trpc';
import { ensureType } from '#schema-loader';
import { EMPTY_PATH_SNAPSHOT, type PathHandle } from '#tree/tree-source';
import { useTreeSource } from '#tree/tree-source-context';

const noopUnsub = () => {};
export { useNavigate, useBeforeNavigate } from '#navigate';

// Server default matches trpc.getChildren schema (engine/core/src/server/trpc.ts:125).
// Consumers who want more per page must pass `limit` explicitly.
const DEFAULT_PAGE_SIZE = 100;

// ── Query<T> — industry-standard reactive fetch shape ──
// Matches React Query / SWR / Apollo / RTK Query. Boring, familiar, trivially
// mockable. See temp/deepthink/hooks-api-redesign.md §2.1.

export type Query<T> = {
  readonly data: T;
  readonly loading: boolean;       // initial fetch in flight, data not yet valid
  readonly error: Error | null;    // last error; cleared on refetch success
  readonly stale: boolean;         // have data, background revalidate in flight
  refetch(): void;                 // stable callback, coalesces if already in flight
};

export type ChildrenQuery = Query<NodeData[]> & {
  readonly total: number | null;   // server-reported total; null until first response
  readonly hasMore: boolean;       // false when total===null; true when data.length < total
  readonly loadingMore: boolean;   // next page append in flight; mutually exclusive with stale
  readonly truncated: boolean | null; // null until first response; true if server hit cap
  loadMore(): void;                // no-op if !hasMore or already loadingMore
};

export type ChildrenOpts = {
  limit?: number;                  // page size; absent = DEFAULT_PAGE_SIZE
  watch?: boolean;                 // subscribe to path updates
  watchNew?: boolean;              // subscribe to new children appearing
};

// ── Watch ref-counting ──
// Multiple components may watch the same parent; ref-count to avoid premature unwatch.
// Path-level watch ref-counting moved into ClientTreeSource.mountPath.

const childrenWatchRefs = new Map<string, number>();

function refWatch(map: Map<string, number>, path: string) {
  map.set(path, (map.get(path) ?? 0) + 1);
}

/** Decrement ref count. Returns true when last consumer unwatched → caller should unwatch on server. */
function unrefWatch(map: Map<string, number>, path: string): boolean {
  const count = (map.get(path) ?? 0) - 1;
  if (count <= 0) { map.delete(path); return true; }
  map.set(path, count);
  return false;
}

// ── usePath: reactive path read → Query<T> ──
//
// URI mode:   usePath('/path#comp.field')      → Query<derived | undefined>
// Typed mode: usePath('/path', MyClass)        → Query<TypeProxy<T>>
// Options:    usePath('/path', { once: true })  → no server watch
//
// Typed mode is the ONE semantic exception where `data` is not fetched content —
// it's a façade proxy whose method calls always work (route to execute()) while
// field reads yield undefined during loading. See plan §2.3.

type PathOpts = { once?: boolean };

export function usePath<T = NodeData>(
  uri: string | null,
  opts?: PathOpts,
): Query<T | undefined>;
export function usePath<T extends object>(
  path: string,
  cls: Class<T>,
  key?: string,
): Query<TypeProxy<T>>;
export function usePath<T extends object>(
  pathOrUri: string | null,
  clsOrOpts?: Class<T> | PathOpts,
  key?: string,
): Query<unknown> {
  const source = useTreeSource();
  const isTyped = typeof clsOrOpts === 'function';
  const cls = isTyped ? clsOrOpts as Class<T> : undefined;
  const opts = isTyped ? undefined : clsOrOpts as PathOpts | undefined;

  const parsed = useMemo(
    () => pathOrUri && !isTyped ? parseURI(pathOrUri) : null,
    [pathOrUri, isTyped],
  );
  const path = isTyped ? pathOrUri : (parsed?.path ?? null);

  // Reactive snapshot — bundles data + status + error in a single reference,
  // stable until any of those three change. Source owns the merge.
  const snap = useSyncExternalStore(
    useCallback(
      (cb: () => void) => path ? source.subscribePath(path, cb) : noopUnsub,
      [source, path],
    ),
    useCallback(
      () => path ? source.getPathSnapshot(path) : EMPTY_PATH_SNAPSHOT,
      [source, path],
    ),
  );

  // Lifecycle — mountPath owns fetch + watch ref-counting + SSE-reset re-fetch.
  // dispose() reverses everything.
  const handleRef = useRef<PathHandle | null>(null);
  useEffect(() => {
    if (!path) { handleRef.current = null; return; }
    debugPath(path, 'usePath');
    const h = source.mountPath(path, opts);
    handleRef.current = h;
    return () => { h.dispose(); handleRef.current = null; };
  }, [source, path, opts?.once]);

  const refetch = useCallback(() => { handleRef.current?.refetch(); }, []);

  // Derived flags — `loading` is status-driven, NOT presence-driven.
  // A null tRPC response settles to 'not_found' → loading flips to false
  // with data:undefined.
  const loading = !path || snap.status === undefined || snap.status === 'loading';
  // Path mode: refetch re-enters 'loading' fully; no background revalidate layer.
  const stale = false;
  const error = snap.error;
  const node = snap.data;

  // Typed mode — façade proxy (method calls work regardless of data state)
  const proxy = useMemo(() => {
    if (!cls || !path) return undefined;
    return makeProxy(path, cls, node, key);
  }, [cls, path, node, key]);

  return useMemo(() => {
    if (cls && path) {
      return { data: proxy, loading, error, stale, refetch };
    }
    const derived = parsed ? deriveURI(node, parsed) : node;
    return { data: derived, loading, error, stale, refetch };
  }, [cls, path, proxy, parsed, node, loading, error, stale, refetch]);
}

function debugPath(path: string, hook: string) {
  if (path.includes('//')) {
    console.error(`[hooks] double slash in ${hook}: ${JSON.stringify(path)}`, new Error('stack'));
  }
}

// ── useChildren: reactive children list → ChildrenQuery ──

export function useChildren(parentPath: string, opts?: ChildrenOpts): ChildrenQuery {
  const gen = useSyncExternalStore(cache.subscribeSSEGen, cache.getSSEGen);

  // Data subscription — children set is the primary reactive source
  const data = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildren(parentPath, cb), [parentPath]),
    useCallback(() => cache.getChildren(parentPath), [parentPath]),
  );

  const error = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildrenError(parentPath, cb), [parentPath]),
    useCallback(() => cache.getChildrenError(parentPath), [parentPath]),
  );

  const phase = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildren(parentPath, cb), [parentPath]),
    useCallback(() => cache.getChildrenPhase(parentPath), [parentPath]),
  );

  const total = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildren(parentPath, cb), [parentPath]),
    useCallback(() => cache.getChildrenTotal(parentPath), [parentPath]),
  );

  const truncated = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribeChildren(parentPath, cb), [parentPath]),
    useCallback(() => cache.getChildrenTruncated(parentPath), [parentPath]),
  );

  // Subscriber lifecycle — retain on mount, release on unmount. Drives
  // childPageSize + loadedCount release when the last consumer for this
  // parent unmounts.
  useEffect(() => {
    cache.retainChildSubscriber(parentPath);
    return () => cache.releaseChildSubscriber(parentPath);
  }, [parentPath]);

  // Fetch effect — initial load OR reconnect OR opts change → REPLACE semantics.
  useEffect(() => {
    debugPath(parentPath, 'useChildren');

    // First-wins page size lock. Second caller with a different limit gets
    // the locked value + a dev warn.
    const effectiveLimit = cache.lockChildPageSize(
      parentPath,
      opts?.limit ?? DEFAULT_PAGE_SIZE,
    );

    // Decide phase: cold (no authoritative collection yet) vs warm
    // (in-session cached → stale data + background refetch).
    // CRITICAL: check `hasChildrenCollectionLoaded`, NOT `parentIndex.has`.
    // The latter conflates "some child cached" with "children list fetched".
    const hasAuthoritative = cache.hasChildrenCollectionLoaded(parentPath);
    cache.setChildrenPhase(parentPath, hasAuthoritative ? 'refetch' : 'initial');

    let cancelled = false;

    trpc.getChildren
      .query({
        path: parentPath,
        limit: effectiveLimit,
        watch: opts?.watch,
        watchNew: opts?.watchNew,
      })
      .then((result: any) => {
        if (cancelled) return;
        cache.replaceChildren(parentPath, result.items as NodeData[]);
        cache.setChildrenTotal(parentPath, result.total);
        cache.setChildrenTruncated(parentPath, !!result.truncated);
        cache.setChildrenError(parentPath, null);
        cache.setChildrenPhase(parentPath, 'ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        cache.setChildrenError(parentPath, err instanceof Error ? err : new Error(String(err)));
        cache.setChildrenPhase(parentPath, 'error');
      });

    return () => { cancelled = true; };
  }, [parentPath, gen, opts?.limit, opts?.watch, opts?.watchNew]);

  // Watch cleanup — unwatchChildren on unmount or path change (ref-counted)
  useEffect(() => {
    if (!(opts?.watch || opts?.watchNew)) return;
    refWatch(childrenWatchRefs, parentPath);
    return () => {
      if (unrefWatch(childrenWatchRefs, parentPath)) {
        trpc.unwatchChildren.mutate({ paths: [parentPath] }).catch(() => {});
      }
    };
  }, [parentPath, opts?.watch, opts?.watchNew]);

  // Derived flags — each state derives from exactly one source.
  const loading = phase === 'idle' || phase === 'initial';
  const stale = phase === 'refetch';
  const loadingMore = phase === 'append';
  const hasMore = total !== null && data.length < total;

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return;
    const pageSize = cache.getChildPageSize(parentPath) ?? DEFAULT_PAGE_SIZE;
    const offset = cache.getLoadedCount(parentPath);
    cache.setChildrenPhase(parentPath, 'append');
    trpc.getChildren
      .query({
        path: parentPath,
        limit: pageSize,
        offset,
      })
      .then((result: any) => {
        cache.appendChildren(parentPath, result.items as NodeData[]);
        cache.setChildrenTotal(parentPath, result.total);
        cache.setChildrenPhase(parentPath, 'ready');
      })
      .catch((err: unknown) => {
        cache.setChildrenError(parentPath, err instanceof Error ? err : new Error(String(err)));
        cache.setChildrenPhase(parentPath, 'error');
      });
  }, [parentPath, hasMore, loadingMore]);

  const refetch = useCallback(() => {
    // Reload the CURRENTLY LOADED WINDOW in one call — preserves scroll position.
    // If user scrolled 60 items via loadMore, refetch issues `limit:60,offset:0`
    // so all 60 rows get replaced.
    const windowSize = cache.getLoadedCount(parentPath)
      || cache.getChildPageSize(parentPath)
      || DEFAULT_PAGE_SIZE;
    cache.setChildrenPhase(parentPath, 'refetch');
    trpc.getChildren
      .query({
        path: parentPath,
        limit: windowSize,
        offset: 0,
        watch: opts?.watch,
        watchNew: opts?.watchNew,
      })
      .then((result: any) => {
        // replaceChildren clamps loadedCount to result.items.length
        cache.replaceChildren(parentPath, result.items as NodeData[]);
        cache.setChildrenTotal(parentPath, result.total);
        cache.setChildrenTruncated(parentPath, !!result.truncated);
        cache.setChildrenError(parentPath, null);
        cache.setChildrenPhase(parentPath, 'ready');
      })
      .catch((err: unknown) => {
        cache.setChildrenError(parentPath, err instanceof Error ? err : new Error(String(err)));
        cache.setChildrenPhase(parentPath, 'error');
      });
  }, [parentPath, opts?.watch, opts?.watchNew]);

  return useMemo(() => ({
    data,
    total,
    hasMore,
    loading,
    loadingMore,
    error,
    stale,
    truncated,
    refetch,
    loadMore,
  }), [data, total, hasMore, loading, loadingMore, error, stale, truncated, refetch, loadMore]);
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

// ── createNode: optimistic create + server persist ──

export async function createNode(path: string, type: string, data?: Record<string, unknown>) {
  // Lazy-load schema so getDefaults can fill required fields for types not
  // yet registered on the client. Caller data overrides defaults.
  await ensureType(type);
  const node: NodeData = { $path: path, $type: type, ...getDefaults(type), ...data };
  cache.put(node);
  try {
    await tree.set(node);
  } catch (err) {
    cache.remove(path);
    throw err;
  }
}

// ── addComponent: attach a typed component to a node (optimistic + patch) ──

export async function addComponent(path: string, name: string, type: string) {
  // Lazy-load schema so getDefaults can fill required fields for types not
  // yet registered on the client.
  await ensureType(type);
  const comp = { $type: type, ...getDefaults(type) };
  const node = cache.get(path);
  if (node) cache.put({ ...node, [name]: comp });
  await trpc.patch.mutate({ path, ops: [['r', name, comp]] });
}

// ── removeComponent: detach a named component from a node (optimistic + patch) ──

export async function removeComponent(path: string, name: string) {
  const node = cache.get(path);
  if (node) {
    const next = { ...node };
    delete next[name];
    cache.put(next);
  }
  await trpc.patch.mutate({ path, ops: [['d', name]] });
}

// ── removeNode: optimistic delete + server persist ──

export async function removeNode(path: string) {
  const prev = cache.get(path);
  cache.remove(path);
  try {
    await tree.remove(path);
  } catch (err) {
    if (prev) cache.put(prev);
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
    const compType = type ?? (cached[key!] as { $type?: string })?.$type ?? cached.$type;
    const meta = getMeta(compType, `action:${action}`);
    if (!meta?.noOptimistic) {
      const cls = resolve(compType, 'class');
      const actionFn = resolve(compType, `action:${action}`, false);
      if (cls && actionFn) pushOptimistic(path, cls, key, actionFn, data);
    }
  }

  return trpc.execute.mutate({ path, type, key, action, data }).catch(err => {
    rollback(path);
    throw err;
  });
};

// ── useCanWrite: ACL-based write permission check ──
// Returns plain boolean — NOT wrapped in Query<T>. See plan §2.4:
// derived ACL bit, false-until-loaded is the safe conservative default.

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
    ? getComponent(node, cls, key)
    : undefined;

  return new Proxy(comp ?? {}, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol') return (comp as Record<symbol, unknown>)?.[prop];
      const meta = getMeta(type, `action:${prop}`);
      if (!meta) return (comp as any)?.[prop];

      if (meta.stream)
        return (data?: unknown) => streamToAsyncIterable({ path, type, key, action: prop, data });

      return (data?: unknown) => execute(path, prop, data, type, key);
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
