// Treenix Hooks — reactive node access with Query<T> shape
// usePath:     reactive path read (URI or typed proxy) → Query<T>
// useChildren: reactive children list with pagination → ChildrenQuery
// set:         persist node (optimistic + server)
// execute:     action caller
// watch:       universal async generator

import { compKey, getComponent, getComponentByName, getMeta, type NodeData, normalizeType, resolve } from '@treenx/core';
import { type Class, getDefaults, type TypeProxy } from '@treenx/core/comp';
import { deriveURI, parseURI } from '@treenx/core/uri';
import type { ChildrenOpts as TreeChildrenOpts } from '@treenx/core/tree';
import { mergeIntoNode, mergeToOps, type OnChange } from '#tree/on-change';
import { trackedGet } from '#tree/read-track';
import { confirmFromResponse, hasPending, pushOptimistic, rollback } from '#tree/rebase';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import * as cache from '#tree/cache';
import { type ClientAction, treeClient } from '#tree/tree-client';
import { type ClientIterator, clientIterator } from '#tree/client-stream';
import { ensureType } from '#schema-loader';
import { type ChildrenHandle, type ChildrenOpts, EMPTY_PATH_SNAPSHOT, type PathHandle } from '#tree/tree-source';
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
  readonly total: number | null;   // number of items in the loaded window
  readonly hasMore: boolean;       // nextCursor present
  readonly loadingMore: boolean;   // next page append in flight; mutually exclusive with stale
  readonly truncated: boolean | null; // null until first response; true if server hit cap
  loadMore(): void;                // no-op if !hasMore or already loadingMore
};

// Single source of truth — the TreeSource contract (limit/query/watch/watchNew).
export type { ChildrenOpts } from '#tree/tree-source';

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

  // Gated multi-query mounts (§4.2, ns6p.4 F6) publish a per-handle snapshot
  // lane instead of the shared parent-keyed cache — consume it when present.
  const [ownLane, setOwnLane] = useState<ChildrenHandle | null>(null);

  // Single bundled snapshot — data + phase + total + truncated + error.
  // Source merges all five into one stable reference; one subscribe channel.
  const snap = useSyncExternalStore(
    useCallback(
      (cb: () => void) => ownLane?.subscribe ? ownLane.subscribe(cb) : source.subscribeChildren(parentPath, cb),
      [source, parentPath, ownLane],
    ),
    useCallback(
      () => ownLane?.getSnapshot ? ownLane.getSnapshot() : source.getChildrenSnapshot(parentPath),
      [source, parentPath, ownLane],
    ),
    useCallback(
      () => ownLane?.getSnapshot ? ownLane.getSnapshot() : source.getChildrenSnapshot(parentPath),
      [source, parentPath, ownLane],
    ),
  );

  // Lifecycle — mountChildren owns fetch + retain/release + watch ref-counting +
  // page-size lock + SSE-reset re-fetch. dispose() reverses everything.
  // Query identity by value — callers pass fresh object literals every render.
  const queryKey = opts?.query ? JSON.stringify(opts.query) : undefined;
  const handleRef = useRef<ChildrenHandle | null>(null);
  useEffect(() => {
    debugPath(parentPath, 'useChildren');
    const h = source.mountChildren(parentPath, opts);
    handleRef.current = h;
    if (h.getSnapshot && h.subscribe) setOwnLane(h);
    return () => {
      h.dispose();
      handleRef.current = null;
      setOwnLane((cur) => cur === h ? null : cur);
    };
  }, [source, parentPath, opts?.limit, opts?.watch, opts?.watchNew, queryKey]);

  const refetch = useCallback(() => { handleRef.current?.refetch(); }, []);
  const loadMore = useCallback(() => { handleRef.current?.loadMore(); }, []);

  // Derived flags — each state derives from exactly one source.
  const loading = snap.phase === 'idle' || snap.phase === 'initial';
  const stale = snap.phase === 'refetch';
  const loadingMore = snap.phase === 'append';
  const hasMore = snap.nextCursor !== null;

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
    await treeClient.commit([{ kind: 'put', node: next }]);
  } catch (err) {
    // F15: rollback optimistic cache on server reject (validation, ACL, OCC)
    if (prev) cache.put(prev); else cache.remove(next.$path);
    throw err;
  }
  // r3-F1a: post-commit refresh through the door — a newer set/remove event
  // landing first must win (a raw cache.put overwrote fresher images and
  // resurrected removes). Server paths refetch via trpc directly: the remote
  // withCache layer never sees SSE invalidations, so a cached hit could feed
  // the door a stale image; /local stays on the FilterTree (memory).
  const o = await trackedGet(
    next.$path,
    () => treeClient.read({ kind: 'node', path: next.$path }),
  );
  if (o.error !== undefined) {
    // Refresh failure is NOT a write failure — the commit stands; rolling back
    // here would diverge from the server permanently once the commit event
    // lands. Loud, non-rolling; the event/door lane owns convergence now.
    console.error('[treenix] set: post-commit refresh failed for', next.$path, o.error);
  }
  return o.node ?? cache.get(next.$path) ?? next;
}

// ── createNode: optimistic create + server persist ──

export async function createNode(path: string, type: string, data?: Record<string, unknown>) {
  // Lazy-load schema so getDefaults can fill required fields for types not
  // yet registered on the client. Caller data overrides defaults.
  await ensureType(type);
  const node: NodeData = { $path: path, $type: type, ...getDefaults(type), ...data };
  cache.put(node);
  try {
    await treeClient.commit([{ kind: 'put', node }]);
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
  const key = compKey(name);
  const prev = cache.get(path);
  if (prev) cache.put({ ...prev, [key]: comp });
  try {
    await treeClient.commit([{ kind: 'patch', path, ops: [['r', key, comp]] }]);
  } catch (err) {
    // F15: rollback optimistic cache on server reject — a failed write emits no
    // SSE event, so a phantom component would persist (incl. IndexedDB) forever.
    if (prev) cache.put(prev);
    throw err;
  }
}

// ── removeComponent: detach a named component from a node (optimistic + patch) ──

export async function removeComponent(path: string, name: string) {
  const key = compKey(name);
  const prev = cache.get(path);
  if (prev) {
    const next = { ...prev };
    delete next[key];
    cache.put(next);
  }
  try {
    await treeClient.commit([{ kind: 'patch', path, ops: [['d', key]] }]);
  } catch (err) {
    // F15: rollback — same contract as addComponent/set.
    if (prev) cache.put(prev);
    throw err;
  }
}

export async function patchNode(path: string, partial: OnChange): Promise<void> {
  const ops = mergeToOps(partial);
  if (!ops.length) return;
  const prev = cache.get(path);
  if (prev) cache.put(mergeIntoNode(prev, partial));
  try {
    await treeClient.commit([{ kind: 'patch', path, ops }]);
  } catch (error) {
    if (prev) cache.put(prev);
    throw error;
  }
}

export function readNode(path: string): Promise<NodeData | undefined> {
  return treeClient.read({ kind: 'node', path });
}

export function readChildren(path: string, options?: TreeChildrenOpts) {
  return treeClient.read({ kind: 'children', path, options });
}

export function refreshChildren(path: string): void {
  cache.signalChildrenDirty(path);
}

// ── removeNode: optimistic delete + server persist ──

export async function removeNode(path: string) {
  const prev = cache.get(path);
  cache.remove(path);
  try {
    await treeClient.commit([{ kind: 'remove', path }]);
  } catch (err) {
    if (prev) cache.put(prev);
    throw err;
  }
}

// ── moveNode: relocate a node to a new path ──
// Mirrors the core relocate contract (FilterTree.patch, core-yje): strip $rev —
// the destination path has no stored node, so a carried rev deterministically
// throws OCC — and write the destination BEFORE removing the source, so a
// rejected write can't lose the node (remove-then-set was cnr.5 C47).

export async function moveNode(fromPath: string, newPath: string): Promise<void> {
  const fromNode = cache.get(fromPath);
  if (!fromNode) throw new Error(`moveNode: ${fromPath} is not in cache`);

  const { $rev, ...body } = fromNode;
  await treeClient.commit([{ kind: 'put', node: { ...body, $path: newPath } }]);
  await treeClient.commit([{ kind: 'remove', path: fromPath }]);
  cache.remove(fromPath);
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

  // opId — idempotency key + ack correlator (core-gk8.1). The server threads it
  // to the write and echoes it as `by` on the resulting event, so rebase can tell
  // our own ack from a foreign write. Generated unconditionally: even when local
  // prediction is skipped, the server still dedups replays on it.
  const opId = crypto.randomUUID();

  // Optimistic: resolve class from cache + registry, predict locally
  const cached = cache.get(path);
  if (cached) {
    const compType = type ?? (key ? getComponentByName(cached, key)?.$type : undefined) ?? cached.$type;
    const meta = getMeta(compType, `action:${action}`);
    // needs → deps are injected server-side only; prediction would run the
    // method with undefined deps (core-anz4.18) — skip, server result syncs.
    if (!meta?.noOptimistic && !meta?.needs) {
      const cls = resolve(compType, 'class');
      const actionFn = resolve(compType, `action:${action}`, false);
      if (cls && actionFn) pushOptimistic(path, cls, key, actionFn, data, opId, { type: compType, action });
    }
  }

  return treeClient.act({ path, type, component: key, action, args: data, opId }).then(
    async result => {
      // Ack-via-response (core-anz4.13): a caller with R+W but no S never gets
      // the `by`-matched event — the overlay would hang forever. The response
      // proves commit; confirm against an authoritative refetch. S callers pass
      // here too — rebase suppresses the later event so it isn't double-applied.
      if (hasPending(path, opId)) await confirmPending(path, opId);
      return result;
    },
    err => {
      rollback(path, opId);
      throw err;
    },
  );
};

async function confirmPending(path: string, opId: string): Promise<void> {
  try {
    const fresh = await treeClient.read({ kind: 'node', path });
    confirmFromResponse(path, opId, fresh ?? undefined);
  } catch (err) {
    const code = (err as { data?: { code?: string }; code?: string }).data?.code
      ?? (err as { code?: string }).code;
    // No R on the result — the action still succeeded; overlay and cache entry
    // are unverifiable now, drop both (confirmFromResponse undefined branch).
    if (code === 'FORBIDDEN') { confirmFromResponse(path, opId, undefined); return; }
    console.warn('[treenix] ack refetch failed — dropping optimistic op for', path, err);
    rollback(path, opId);
  }
}

// ── useCanWrite: ACL-based write permission check ──
// Returns plain boolean — NOT wrapped in Query<T>. See plan §2.4:
// derived ACL bit, false-until-loaded is the safe conservative default.

const W = 2;
const permCache = new Map<string, { perm: number; ts: number }>();
const PERM_TTL = 30_000; // 30s cache

export function useCanWrite(path: string | null): boolean {
  // Key the perm to its path. After a path change React re-renders with the
  // NEW path but the OLD state until the effect commits — so we must derive
  // the effective perm from `state.path === path`, falling closed otherwise.
  // Without this gate the hook returns the previous `true` for one render.
  const [state, setState] = useState<{ path: string | null; perm: number }>({ path: null, perm: 0 });

  useEffect(() => {
    if (!path) { setState({ path: null, perm: 0 }); return; }

    const cached = permCache.get(path);
    if (cached && Date.now() - cached.ts < PERM_TTL) {
      setState({ path, perm: cached.perm });
      return;
    }
    // Set the key immediately so the next render fails closed for this path
    // while the request is in flight (rather than carrying the prior path's perm).
    setState({ path, perm: 0 });

    let cancelled = false;
    treeClient.read({ kind: 'permission', path }).then((p) => {
      if (cancelled) return;
      permCache.set(path, { perm: p, ts: Date.now() });
      setState({ path, perm: p });
    }).catch((e) => {
      if (cancelled) return;
      console.warn('[useCanWrite] getPerm failed for', path, e);
      setState({ path, perm: 0 });
    });
    return () => { cancelled = true; };
  }, [path]);

  const effectivePerm = state.path === path ? state.perm : 0;
  return (effectivePerm & W) !== 0;
}

// ── Internals ──

function streamToAsyncIterable<T>(
  action: ClientAction,
) {
  return {
    [Symbol.asyncIterator](): ClientIterator<T> {
      return clientIterator(observer => treeClient.sub({ kind: 'action', action, observer }));
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
        return (data?: unknown) => streamToAsyncIterable({ path, type, component: key, action: prop, args: data });

      return (data?: unknown) => execute(path, prop, data, type, key);
    },
  }) as TypeProxy<T>;
}

// ── watch: universal async generator ──

export function watch<T = unknown>(uri: string): ClientIterator<T | undefined> {
  const parsed = parseURI(uri);

  if (parsed.action) {
    return streamToAsyncIterable<T>({
      path: parsed.path,
      component: parsed.key,
      action: parsed.action,
      args: parsed.data,
    })[Symbol.asyncIterator]();
  }

  return clientIterator(observer => treeClient.sub({
    kind: 'path', path: parsed.path,
    observer: {
      next(node) { observer.next(deriveURI<T>(node, parsed)); },
      error: observer.error,
      complete: observer.complete,
    },
  }), true);
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
