// TreeSource — abstraction over the reactive node store consumed by hooks.
//
// Source owners:
//   LaneTreeSource (this package) — canonical TWP subscription resources.
//   ServerTreeSource (@treenx/ssr)  — wraps a request-scoped Reader, no-op subscribe,
//                                     synchronous reads, flush-pending render loop.
//
// Hooks consume only this interface (via TreeSourceProvider). The split lets
// the @treenx/react bundle render server-side without dragging the tRPC client
// or SSE plumbing into Node.

import type { PresentationNode } from '#tree/presentation';
import type { ErrorCopy, SubSelector } from '@treenx/core/kernel/types';
import type { NativeMount, NativeSnapshot } from '#tree/native-source';
import type { TreeEffects } from '#tree/effects';
import type { LaneConnection } from '#tree/lane-tree-client';

export type PathStatus = 'loading' | 'ready' | 'not_found' | 'error';
export type ChildrenPhase = 'idle' | 'initial' | 'refetch' | 'append' | 'ready' | 'error';

export type ChildrenOpts = {
  /** Page size; absent = source default. Legacy sources lock it per parent; native lanes own each exact window. */
  limit?: number;
  /** Caller predicate (callerWhere, core-92z). Server paginates query views by
   *  cursor and rejects watch/watchNew alongside query until Stage 6d.
   *  NOTE: children state is keyed by parent path — two mounts of the same
   *  parent with different queries share one collection (first-caller-wins,
   *  same as `limit`). Native lanes retain separate query windows and canonical live coverage. */
  query?: Record<string, unknown>;
  /** Subscribe to path updates server-side (ref-counted). */
  watch?: boolean;
  /** Subscribe to new-children events server-side (ref-counted). */
  watchNew?: boolean;
};

export type PathOpts = {
  /** Legacy sources fetch once without a watch. Native lanes retain subscription coverage until disposal. */
  once?: boolean;
};

export type PathSnapshot = {
  data: PresentationNode | undefined;
  status: PathStatus | undefined;
  error: Error | null;
};

export type ChildrenSnapshot = {
  data: PresentationNode[];
  /** Native per-node projection failures keep their identity and leave healthy rows available. */
  errors?: readonly ErrorCopy[];
  phase: ChildrenPhase;
  /** Resume token from the last page. Non-null means more items are available. */
  nextCursor: string | null;
  error: Error | null;
};

/** Returned from TreeSource.mountPath — owns the path's lifecycle. */
export type PathHandle = {
  /** Re-fetch the path; preserves watch subscription. */
  refetch(): void;
  /** Tear down: unsubscribe, ref-decrement watch, release any locks. */
  dispose(): void;
};

/** Returned from TreeSource.mountChildren — owns the parent's lifecycle. */
export type ChildrenHandle = {
  /** Re-fetch the currently-loaded window (preserves scroll). */
  refetch(): void;
  /** Append the next page; no-op when nothing more to load. */
  loadMore(): void;
  /** Tear down: unsubscribe, ref-decrement watch, release page-size lock. */
  dispose(): void;
  /** Present on gated multi-query mounts (§4.2, ns6p.4 F6): the mount's
   *  results live in a per-handle snapshot, never the shared parent-keyed
   *  cache — its consumer must read/subscribe HERE instead of the source. */
  getSnapshot?(): ChildrenSnapshot;
  subscribe?(cb: () => void): () => void;
};

export interface TreeSource {
  readonly effects?: TreeEffects;
  readonly connection?: LaneConnection;
  // ── Reactive snapshots (stable references; only change when underlying data does) ──

  /** Snapshot for a single path. Returns the same object reference until the
   *  path's data, status, or error changes. */
  getPathSnapshot(path: string): PathSnapshot;

  /** Snapshot for a parent's children list. Returns the same reference until
   *  data, phase, continuation, or error for this parent changes. */
  getChildrenSnapshot(path: string, opts?: ChildrenOpts): ChildrenSnapshot;

  // ── Change notification ──

  subscribePath(path: string, cb: () => void): () => void;
  subscribeChildren(path: string, cb: () => void): () => void;

  // ── Lifecycle (ownership of fetch + watch + reset-handling) ──
  //
  // `mountPath` / `mountChildren` are the ONLY effectful entry points hooks
// use. They acquire native subscription coverage and pagination resources.
// `dispose()` reverses everything mount allocated.
  //
  // For SSR (ServerTreeSource): mountPath / mountChildren record the path as
  // pending and return inert handles; the next render pass flushes pending.

  mountPath(path: string, opts?: PathOpts): PathHandle;
  mountChildren(path: string, opts?: ChildrenOpts): ChildrenHandle;
  /** Native selector coverage includes related copies in the same owned subscription. */
  getSelectorSnapshot?(selector: SubSelector): NativeSnapshot;
  mountSelector?(selector: SubSelector): NativeMount;
}

// ── Empty snapshots — used when path is null/empty ──

export const EMPTY_PATH_SNAPSHOT: PathSnapshot = Object.freeze({
  data: undefined,
  status: undefined,
  error: null,
});

const EMPTY_CHILDREN: PresentationNode[] = [];

// Outer object frozen so snapshot fields can't be reassigned. The empty `data`
// array is intentionally left unfrozen — its type is PresentationNode[] (matching
// cache.getChildren's mutable return), and a frozen array would force an
// unsafe widening cast. The sentinel name signals "do not mutate".
export const EMPTY_CHILDREN_SNAPSHOT: ChildrenSnapshot = Object.freeze({
  data: EMPTY_CHILDREN,
  phase: 'idle',
  nextCursor: null,
  error: null,
});

const NOOP = () => {};
export const NOOP_PATH_HANDLE: PathHandle = Object.freeze({ refetch: NOOP, dispose: NOOP });
export const NOOP_CHILDREN_HANDLE: ChildrenHandle = Object.freeze({
  refetch: NOOP,
  loadMore: NOOP,
  dispose: NOOP,
});

export class TreeSourceMissingError extends Error {
  constructor() {
    super(
      'No <TreeSourceProvider> found. Wrap your app with ' +
        '<TreeSourceProvider source={createLaneTreeSource(client)}>.',
    );
    this.name = 'TreeSourceMissingError';
  }
}
