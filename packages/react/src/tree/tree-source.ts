// TreeSource — abstraction over the reactive node store consumed by hooks.
//
// Two implementations:
//   ClientTreeSource (this package) — wraps in-memory cache + tRPC + SSE.
//   ServerTreeSource (@treenx/ssr)  — wraps an ACL-scoped Tree, no-op subscribe,
//                                     synchronous reads, flush-pending render loop.
//
// Hooks consume only this interface (via TreeSourceProvider). The split lets
// the @treenx/react bundle render server-side without dragging the tRPC client
// or SSE plumbing into Node.

import type { NodeData } from '@treenx/core';
import type { ChildrenPhase, PathStatus } from './cache';

export type ChildrenOpts = {
  /** Page size; absent = source default. First-caller-wins per parent. */
  limit?: number;
  /** Subscribe to path updates server-side (ref-counted). */
  watch?: boolean;
  /** Subscribe to new-children events server-side (ref-counted). */
  watchNew?: boolean;
};

export type PathOpts = {
  /** Skip server watch — one-shot fetch. */
  once?: boolean;
};

export type PathSnapshot = {
  data: NodeData | undefined;
  status: PathStatus | undefined;
  error: Error | null;
};

export type ChildrenSnapshot = {
  data: NodeData[];
  phase: ChildrenPhase;
  total: number | null;
  truncated: boolean | null;
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
};

export interface TreeSource {
  // ── Reactive snapshots (stable references; only change when underlying data does) ──

  /** Snapshot for a single path. Returns the same object reference until the
   *  path's data, status, or error changes. */
  getPathSnapshot(path: string): PathSnapshot;

  /** Snapshot for a parent's children list. Returns the same reference until
   *  any of (data, phase, total, truncated, error) for this parent changes. */
  getChildrenSnapshot(path: string): ChildrenSnapshot;

  // ── Change notification ──

  subscribePath(path: string, cb: () => void): () => void;
  subscribeChildren(path: string, cb: () => void): () => void;

  // ── Lifecycle (ownership of fetch + watch + reset-handling) ──
  //
  // `mountPath` / `mountChildren` are the ONLY effectful entry points hooks
  // use. They encapsulate fetch, watch ref-counting, SSE-reset re-fetch, and
  // page-size lock release. `dispose()` reverses everything mount allocated.
  //
  // For SSR (ServerTreeSource): mountPath / mountChildren record the path as
  // pending and return inert handles; the next render pass flushes pending.

  mountPath(path: string, opts?: PathOpts): PathHandle;
  mountChildren(path: string, opts?: ChildrenOpts): ChildrenHandle;
}

// ── Empty snapshots — used when path is null/empty ──

export const EMPTY_PATH_SNAPSHOT: PathSnapshot = Object.freeze({
  data: undefined,
  status: undefined,
  error: null,
});

const EMPTY_CHILDREN: NodeData[] = [];

// Outer object frozen so snapshot fields can't be reassigned. The empty `data`
// array is intentionally left unfrozen — its type is NodeData[] (matching
// cache.getChildren's mutable return), and a frozen array would force an
// unsafe widening cast. The sentinel name signals "do not mutate".
export const EMPTY_CHILDREN_SNAPSHOT: ChildrenSnapshot = Object.freeze({
  data: EMPTY_CHILDREN,
  phase: 'idle',
  total: null,
  truncated: null,
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
      '<TreeSourceProvider source={createClientTreeSource()}>.',
    );
    this.name = 'TreeSourceMissingError';
  }
}
