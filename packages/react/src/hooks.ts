import type { PresentationNode } from '#tree/presentation';
import type { ErrorCopy } from '@treenx/core/kernel/types';
// Treenix Hooks — reactive node access with Query<T> shape
// usePath:     reactive path read (URI or typed proxy) → Query<T>
// useChildren: reactive children list with pagination → ChildrenQuery

import { makeTypedProxy } from '@treenx/core/comp/handle';
import { type Class, type TypeProxy } from '@treenx/core/comp';
import { deriveURI, parseURI } from '@treenx/core/uri';
import { mergeIntoNode, type OnChange } from '#tree/on-change';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type ChildrenHandle,
  type ChildrenOpts,
  EMPTY_PATH_SNAPSHOT,
  type PathHandle,
} from '#tree/tree-source';
import { useTreeSource } from '#tree/tree-source-context';
import { useTreeEffects, type TreeEffects } from '#tree/effects';

export { useTreeEffects } from '#tree/effects';

const noopUnsub = () => {};
const NO_CHILD_ERRORS: readonly ErrorCopy[] = [];
export { useNavigate, useBeforeNavigate } from '#navigate';
export { useTheme, type Theme, type UseThemeResult, type CustomThemeSpec } from '#hooks/use-theme';

// ── Query<T> — industry-standard reactive fetch shape ──
// Matches React Query / SWR / Apollo / RTK Query. Boring, familiar, trivially
// mockable. See temp/deepthink/hooks-api-redesign.md §2.1.

export type Query<T> = {
  readonly data: T;
  readonly loading: boolean; // initial fetch in flight, data not yet valid
  readonly error: Error | null; // last error; cleared on refetch success
  readonly stale: boolean; // have data, background revalidate in flight
  refetch(): void; // stable callback, coalesces if already in flight
};

export type ChildrenQuery = Query<PresentationNode[]> & {
  readonly errors: readonly ErrorCopy[];
  readonly hasMore: boolean; // nextCursor present
  readonly loadingMore: boolean; // next page append in flight; mutually exclusive with stale
  loadMore(): void; // no-op if !hasMore or already loadingMore
};

// Single source of truth — the TreeSource contract (limit/query/watch/watchNew).
export type { ChildrenOpts } from '#tree/tree-source';

// Subscription coverage and pagination belong to the selected TreeSource.

// ── usePath: reactive path read → Query<T> ──
//
// URI mode:   usePath('/path#comp.field')      → Query<derived | undefined>
// Typed mode: usePath('/path', MyClass)        → Query<TypeProxy<T>>
// Options:    usePath('/path', { once: true })  → legacy one-shot; native coverage remains owned until disposal
//
// Typed mode is the ONE semantic exception where `data` is not fetched content —
// it's a façade proxy whose method calls always work (route to execute()) while
// field reads yield undefined during loading. See plan §2.3.

type PathOpts = { once?: boolean };

export function usePath<T = PresentationNode>(
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
  const effects = useTreeEffects();
  const isTyped = typeof clsOrOpts === 'function';
  const cls = isTyped ? (clsOrOpts as Class<T>) : undefined;
  const opts = isTyped ? undefined : (clsOrOpts as PathOpts | undefined);

  const parsed = useMemo(
    () => (pathOrUri && !isTyped ? parseURI(pathOrUri) : null),
    [pathOrUri, isTyped],
  );
  const path = isTyped ? pathOrUri : (parsed?.path ?? null);

  // Reactive snapshot — bundles data + status + error in a single reference,
  // stable until any of those three change. Source owns the merge.
  const snap = useSyncExternalStore(
    useCallback(
      (cb: () => void) => (path ? source.subscribePath(path, cb) : noopUnsub),
      [source, path],
    ),
    useCallback(() => (path ? source.getPathSnapshot(path) : EMPTY_PATH_SNAPSHOT), [source, path]),
    useCallback(() => (path ? source.getPathSnapshot(path) : EMPTY_PATH_SNAPSHOT), [source, path]),
  );

  // Lifecycle — mountPath owns reads and native subscription coverage.
  // dispose() reverses everything.
  const handleRef = useRef<PathHandle | null>(null);
  useEffect(() => {
    if (!path) {
      handleRef.current = null;
      return;
    }
    debugPath(path, 'usePath');
    const h = source.mountPath(path, opts);
    handleRef.current = h;
    return () => {
      h.dispose();
      handleRef.current = null;
    };
  }, [source, path, opts?.once]);

  const refetch = useCallback(() => {
    handleRef.current?.refetch();
  }, []);

  // Derived flags — `loading` is status-driven, NOT presence-driven.
  // A completed empty snapshot settles to 'not_found' → loading flips to false
  // with data:undefined.
  const loading = !path || snap.status === undefined || snap.status === 'loading';
  // Path mode: refetch re-enters 'loading' fully; no background revalidate layer.
  const stale = false;
  const error = snap.error;
  const node = snap.data;

  // Typed mode — façade proxy (method calls work regardless of data state)
  const proxy = useMemo(() => {
    if (!cls || !path) return undefined;
    return makeProxy(path, cls, node, effects, key);
  }, [cls, path, node, effects, key]);

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
  const queryKey = opts?.query ? JSON.stringify(opts.query) : undefined;
  const [ownedLane, setOwnLane] = useState<{
    source: typeof source;
    path: string;
    limit?: number;
    watch?: boolean;
    watchNew?: boolean;
    queryKey?: string;
    handle: ChildrenHandle;
  } | null>(null);
  const ownLane =
    ownedLane?.source === source &&
    ownedLane.path === parentPath &&
    ownedLane.limit === opts?.limit &&
    ownedLane.watch === opts?.watch &&
    ownedLane.watchNew === opts?.watchNew &&
    ownedLane.queryKey === queryKey
      ? ownedLane.handle
      : undefined;

  // The owning source publishes data, phase, continuation, and failure atomically.
  const snap = useSyncExternalStore(
    useCallback(
      (cb: () => void) =>
        ownLane?.subscribe ? ownLane.subscribe(cb) : source.subscribeChildren(parentPath, cb),
      [source, parentPath, ownLane, opts?.limit, opts?.watch, opts?.watchNew, queryKey],
    ),
    useCallback(
      () =>
        ownLane?.getSnapshot ? ownLane.getSnapshot() : source.getChildrenSnapshot(parentPath, opts),
      [source, parentPath, ownLane, opts?.limit, opts?.watch, opts?.watchNew, queryKey],
    ),
    useCallback(
      () =>
        ownLane?.getSnapshot ? ownLane.getSnapshot() : source.getChildrenSnapshot(parentPath, opts),
      [source, parentPath, ownLane, opts?.limit, opts?.watch, opts?.watchNew, queryKey],
    ),
  );

  // Lifecycle — mountChildren owns fetch + retain/release + watch ref-counting +
  // the requested page window. dispose() reverses everything.
  // Query identity by value — callers pass fresh object literals every render.
  const handleRef = useRef<ChildrenHandle | null>(null);
  useEffect(() => {
    debugPath(parentPath, 'useChildren');
    const h = source.mountChildren(parentPath, opts);
    handleRef.current = h;
    if (h.getSnapshot && h.subscribe)
      setOwnLane({
        source,
        path: parentPath,
        limit: opts?.limit,
        watch: opts?.watch,
        watchNew: opts?.watchNew,
        queryKey,
        handle: h,
      });
    return () => {
      h.dispose();
      handleRef.current = null;
      setOwnLane((cur) => (cur?.handle === h ? null : cur));
    };
  }, [source, parentPath, opts?.limit, opts?.watch, opts?.watchNew, queryKey]);

  const refetch = useCallback(() => {
    handleRef.current?.refetch();
  }, []);
  const loadMore = useCallback(() => {
    handleRef.current?.loadMore();
  }, []);

  // Derived flags — each state derives from exactly one source.
  const loading = snap.phase === 'idle' || snap.phase === 'initial';
  const stale = snap.phase === 'refetch';
  const loadingMore = snap.phase === 'append';
  const hasMore = snap.nextCursor !== null;

  return useMemo(
    () => ({
      data: snap.data,
      errors: snap.errors ?? NO_CHILD_ERRORS,
      hasMore,
      loading,
      loadingMore,
      error: snap.error,
      stale,
      refetch,
      loadMore,
    }),
    [snap, hasMore, loading, loadingMore, stale, refetch, loadMore],
  );
}

export interface ActionResults {}

/** Named producers publish their exact piece type; dynamic action streams remain unknown. */
export interface ActionChunks {}

// ── useCanWrite: ACL-based write permission check ──
// Returns plain boolean — NOT wrapped in Query<T>. See plan §2.4:
// derived ACL bit, false-until-loaded is the safe conservative default.

const W = 2;
/** Derive write permission from the copy admitted by the current source. */
export function useCanWrite(path: string | null): boolean {
  const source = useTreeSource();
  const effects = useTreeEffects();
  useSyncExternalStore(
    (callback) => (path === null ? () => {} : source.subscribePath(path, callback)),
    () => (path === null ? undefined : source.getPathSnapshot(path)),
    () => (path === null ? undefined : source.getPathSnapshot(path)),
  );
  return path !== null && ((effects.bits(path) ?? 0) & W) !== 0;
}

// ── Internals ──

/** Dispatch interface-only actions through the native owner using the shared typed proxy. */
function makeProxy<T extends object>(
  path: string,
  cls: Class<T>,
  node: PresentationNode | undefined,
  effects: TreeEffects,
  key?: string,
): TypeProxy<T> {
  return makeTypedProxy(
    node,
    cls,
    path,
    (input) => effects.execute(input.path, input.action, input.data, input.type, input.key),
    (input) =>
      effects.stream({
        path: input.path,
        type: input.type,
        component: input.key,
        action: input.action,
        args: input.data,
      }),
    key,
  );
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
    setState(
      (p) => mergeIntoNode(p as Record<string, unknown>, partial as Record<string, unknown>) as T,
    );
    sinkRef.current?.(partial);
  }, []);
  return [state, onChange];
}
