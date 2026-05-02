// ClientTreeSource — the production TreeSource used in the SPA.
// Wraps the in-memory cache + tRPC transport + SSE generation.
// All side effects (fetch, watch ref-counting, reset re-fetch) live here so
// the React hooks become thin presenters and the SSR ServerTreeSource can
// implement the same interface without touching tRPC or SSE.

import type { NodeData } from '@treenx/core';
import * as cache from './cache';
import { tree as clientTree } from './client';
import { trpc } from './trpc';
import {
  type ChildrenHandle,
  type ChildrenOpts,
  type ChildrenSnapshot,
  type PathHandle,
  type PathOpts,
  type PathSnapshot,
  type TreeSource,
} from './tree-source';

const DEFAULT_PAGE_SIZE = 100;

// Watch ref-counting — multiple components may mount the same path; only
// unwatch on the server when the last consumer goes away.
type RefMap = Map<string, number>;
function refWatch(map: RefMap, path: string): void {
  map.set(path, (map.get(path) ?? 0) + 1);
}
function unrefWatch(map: RefMap, path: string): boolean {
  const n = (map.get(path) ?? 0) - 1;
  if (n <= 0) { map.delete(path); return true; }
  map.set(path, n);
  return false;
}

export class ClientTreeSource implements TreeSource {
  // Stable-reference snapshot caches. useSyncExternalStore requires the same
  // object identity until the underlying state actually changes.
  private pathSnaps = new Map<string, PathSnapshot>();
  private childSnaps = new Map<string, ChildrenSnapshot>();

  private pathWatchRefs: RefMap = new Map();
  private childrenWatchRefs: RefMap = new Map();

  // ── Snapshots ──

  getPathSnapshot(path: string): PathSnapshot {
    const data = cache.get(path);
    const status = cache.getPathStatus(path);
    const error = cache.getPathError(path);
    const prev = this.pathSnaps.get(path);
    if (prev && prev.data === data && prev.status === status && prev.error === error) {
      return prev;
    }
    const next: PathSnapshot = { data, status, error };
    this.pathSnaps.set(path, next);
    return next;
  }

  getChildrenSnapshot(path: string): ChildrenSnapshot {
    const data = cache.getChildren(path);
    const phase = cache.getChildrenPhase(path);
    const total = cache.getChildrenTotal(path);
    const truncated = cache.getChildrenTruncated(path);
    const error = cache.getChildrenError(path);
    const prev = this.childSnaps.get(path);
    if (
      prev
      && prev.data === data
      && prev.phase === phase
      && prev.total === total
      && prev.truncated === truncated
      && prev.error === error
    ) {
      return prev;
    }
    const next: ChildrenSnapshot = { data, phase, total, truncated, error };
    this.childSnaps.set(path, next);
    return next;
  }

  // ── Subscriptions (data + error fan-out into one callback) ──

  subscribePath(path: string, cb: () => void): () => void {
    const u1 = cache.subscribePath(path, cb);
    const u2 = cache.subscribePathError(path, cb);
    return () => { u1(); u2(); };
  }

  subscribeChildren(path: string, cb: () => void): () => void {
    const u1 = cache.subscribeChildren(path, cb);
    const u2 = cache.subscribeChildrenError(path, cb);
    return () => { u1(); u2(); };
  }

  // ── mountPath: fetch + watch + reset listener ──

  mountPath(path: string, opts?: PathOpts): PathHandle {
    const watching = !opts?.once;
    let cancelled = false;

    const fetchOnce = () => {
      if (cancelled) return;
      cache.setPathStatus(path, 'loading');
      trpc.get.query({ path, watch: watching })
        .then((n: unknown) => {
          if (cancelled) return;
          if (n) cache.put(n as NodeData);
          else cache.markPathMissing(path);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          cache.setPathError(path, err instanceof Error ? err : new Error(String(err)));
          cache.setPathStatus(path, 'error');
        });
    };

    fetchOnce();
    if (watching) refWatch(this.pathWatchRefs, path);
    // SSE reconnect → re-fetch (preserved=false means generation bumped).
    const unsubReset = cache.subscribeSSEGen(fetchOnce);

    return {
      refetch: fetchOnce,
      dispose: () => {
        cancelled = true;
        unsubReset();
        if (watching && unrefWatch(this.pathWatchRefs, path)) {
          trpc.unwatch.mutate({ paths: [path] }).catch(() => {});
        }
      },
    };
  }

  // ── mountChildren: fetch + paginate + watch + reset listener ──

  mountChildren(path: string, opts?: ChildrenOpts): ChildrenHandle {
    let cancelled = false;
    cache.retainChildSubscriber(path);
    const watching = !!(opts?.watch || opts?.watchNew);
    if (watching) refWatch(this.childrenWatchRefs, path);

    const initialFetch = () => {
      if (cancelled) return;
      const limit = cache.lockChildPageSize(path, opts?.limit ?? DEFAULT_PAGE_SIZE);
      const hasAuthoritative = cache.hasChildrenCollectionLoaded(path);
      cache.setChildrenPhase(path, hasAuthoritative ? 'refetch' : 'initial');

      trpc.getChildren
        .query({ path, limit, watch: opts?.watch, watchNew: opts?.watchNew })
        .then((result: { items: NodeData[]; total: number; truncated?: boolean }) => {
          if (cancelled) return;
          cache.replaceChildren(path, result.items);
          cache.setChildrenTotal(path, result.total);
          cache.setChildrenTruncated(path, !!result.truncated);
          cache.setChildrenError(path, null);
          cache.setChildrenPhase(path, 'ready');
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          cache.setChildrenError(path, err instanceof Error ? err : new Error(String(err)));
          cache.setChildrenPhase(path, 'error');
        });
    };

    const refetch = () => {
      if (cancelled) return;
      // Reload the currently-loaded window (preserves scroll position).
      const windowSize = cache.getLoadedCount(path)
        || cache.getChildPageSize(path)
        || DEFAULT_PAGE_SIZE;
      cache.setChildrenPhase(path, 'refetch');
      trpc.getChildren
        .query({ path, limit: windowSize, offset: 0, watch: opts?.watch, watchNew: opts?.watchNew })
        .then((result: { items: NodeData[]; total: number; truncated?: boolean }) => {
          if (cancelled) return;
          cache.replaceChildren(path, result.items);
          cache.setChildrenTotal(path, result.total);
          cache.setChildrenTruncated(path, !!result.truncated);
          cache.setChildrenError(path, null);
          cache.setChildrenPhase(path, 'ready');
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          cache.setChildrenError(path, err instanceof Error ? err : new Error(String(err)));
          cache.setChildrenPhase(path, 'error');
        });
    };

    const loadMore = () => {
      if (cancelled) return;
      const total = cache.getChildrenTotal(path);
      const loaded = cache.getLoadedCount(path);
      const pageSize = cache.getChildPageSize(path) ?? DEFAULT_PAGE_SIZE;
      if (total === null || loaded >= total) return;
      if (cache.getChildrenPhase(path) === 'append') return;
      cache.setChildrenPhase(path, 'append');
      trpc.getChildren
        .query({ path, limit: pageSize, offset: loaded })
        .then((result: { items: NodeData[]; total: number }) => {
          if (cancelled) return;
          cache.appendChildren(path, result.items);
          cache.setChildrenTotal(path, result.total);
          cache.setChildrenPhase(path, 'ready');
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          cache.setChildrenError(path, err instanceof Error ? err : new Error(String(err)));
          cache.setChildrenPhase(path, 'error');
        });
    };

    initialFetch();
    const unsubReset = cache.subscribeSSEGen(initialFetch);

    return {
      refetch,
      loadMore,
      dispose: () => {
        cancelled = true;
        unsubReset();
        cache.releaseChildSubscriber(path);
        if (watching && unrefWatch(this.childrenWatchRefs, path)) {
          trpc.unwatchChildren.mutate({ paths: [path] }).catch(() => {});
        }
      },
    };
  }
}

/** Create the production source. The SPA root constructs one and feeds it
 *  into <TreeSourceProvider>. Tests construct fakes that satisfy TreeSource. */
export function createClientTreeSource(): ClientTreeSource {
  // clientTree is referenced here so the underlying client tRPC tree boots
  // (it's used by hooks.ts:set/remove for now; once those are pulled into the
  // source in Phase 1b, this side import goes away).
  void clientTree;
  return new ClientTreeSource();
}
