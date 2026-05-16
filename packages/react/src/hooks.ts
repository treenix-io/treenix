// Treenix Hooks — reactive node access with Query<T> shape
// usePath:     reactive path read (URI or typed proxy) → Query<T>
// useChildren: reactive children list with pagination → ChildrenQuery
// set:         persist node (optimistic + server)
// execute:     action caller
// watch:       universal async generator

import { getComponent, getMeta, type NodeData, normalizeType, resolve } from '@treenx/core';
import { type Class, getDefaults, type TypeProxy } from '@treenx/core/comp';
import { deriveURI, parseURI } from '@treenx/core/uri';
import { mergeIntoNode, type OnChange } from '#tree/on-change';
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
import { type ChildrenHandle, EMPTY_PATH_SNAPSHOT, type PathHandle } from '#tree/tree-source';
import { useTreeSource } from '#tree/tree-source-context';

const noopUnsub = () => {};
export { useNavigate, useBeforeNavigate } from '#navigate';
export { useTheme, type Theme, type UseThemeResult, type CustomThemeSpec } from '#hooks/use-theme';

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
  limit?: number;                  // page size; absent = source default (100)
  watch?: boolean;                 // subscribe to path updates
  watchNew?: boolean;              // subscribe to new children appearing
};

// Watch ref-counting + page-size tracking now live in ClientTreeSource.

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
  const source = useTreeSource();

  // Single bundled snapshot — data + phase + total + truncated + error.
  // Source merges all five into one stable reference; one subscribe channel.
  const snap = useSyncExternalStore(
    useCallback((cb: () => void) => source.subscribeChildren(parentPath, cb), [source, parentPath]),
    useCallback(() => source.getChildrenSnapshot(parentPath), [source, parentPath]),
    useCallback(() => source.getChildrenSnapshot(parentPath), [source, parentPath]),
  );

  // Lifecycle — mountChildren owns fetch + retain/release + watch ref-counting +
  // page-size lock + SSE-reset re-fetch. dispose() reverses everything.
  const handleRef = useRef<ChildrenHandle | null>(null);
  useEffect(() => {
    debugPath(parentPath, 'useChildren');
    const h = source.mountChildren(parentPath, opts);
    handleRef.current = h;
    return () => { h.dispose(); handleRef.current = null; };
  }, [source, parentPath, opts?.limit, opts?.watch, opts?.watchNew]);

  const refetch = useCallback(() => { handleRef.current?.refetch(); }, []);
  const loadMore = useCallback(() => { handleRef.current?.loadMore(); }, []);

  // Derived flags — each state derives from exactly one source.
  const loading = snap.phase === 'idle' || snap.phase === 'initial';
  const stale = snap.phase === 'refetch';
  const loadingMore = snap.phase === 'append';
  const hasMore = snap.total !== null && snap.data.length < snap.total;

  return useMemo(() => ({
    data: snap.data,
    total: snap.total,
    hasMore,
    loading,
    loadingMore,
    error: snap.error,
    stale,
    truncated: snap.truncated,
    refetch,
    loadMore,
  }), [snap, hasMore, loading, loadingMore, stale, refetch, loadMore]);
}

// ── set: optimistic update + server persist ──
// Returns the fresh node from server (with bumped $rev) so callers that hold
// a local copy of the saved node — e.g. JSON editor — can reflect the new
// $rev. Without this, a second save reuses the stale OCC token and trips
// CONFLICT (Expected $rev N+1, got N).

export async function set(next: NodeData): Promise<NodeData> {
  const prev = cache.get(next.$path);
  cache.put(next);
  try {
    await tree.set(next);
    const fresh = await tree.get(next.$path);
    if (fresh) cache.put(fresh);
    return fresh ?? next;
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
      if (cls && actionFn) pushOptimistic(path, cls, key, actionFn, data, { type: compType, action });
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

// ── useValue: useState with OnChange-shaped setter, resets when input identity changes ──
//
// Returns [value, onChange] matching our controlled-component contract
// (top-level keys or dot-paths; undefined deletes — see OnChange).
//
//   const [v, onChange] = useValue(useMemo(() => stampComponent({ ... }, node), [node]));
//
// When the input identity changes, local state resets to the new input
// (Adjusting-State-on-Props-Change pattern: in-render setState).
export function useValue<T extends object>(
  input: T,
  onSink?: (partial: OnChange<T>) => void,
): [T, (partial: OnChange<T>) => void] {
  const [state, setState] = useState(input);
  const [prev, setPrev] = useState(input);
  if (prev !== input) {
    setPrev(input);
    setState(input);
  }
  const sinkRef = useRef(onSink);
  sinkRef.current = onSink;
  const onChange = useCallback((partial: OnChange<T>) => {
    setState(p => mergeIntoNode(p as Record<string, unknown>, partial as Record<string, unknown>) as T);
    sinkRef.current?.(partial);
  }, []);
  return [state, onChange];
}
