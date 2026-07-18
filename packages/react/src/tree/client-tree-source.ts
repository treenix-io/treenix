// ClientTreeSource — the production TreeSource used in the SPA.
// Wraps the in-memory cache + tRPC transport + SSE generation.
// All side effects (fetch, watch ref-counting, reset re-fetch) live here so
// the React hooks become thin presenters and the SSR ServerTreeSource can
// implement the same interface without touching tRPC or SSE.

import type { NodeData } from '@treenx/core';
// Use the package-internal alias (#tree/...) — NOT relative './cache' — so
// Vite deduplicates with hooks.ts's import. Two URLs for the same file
// produce two ESM module instances, two cache singletons, broken reactivity.
import * as cache from '#tree/cache';
import { tree as clientTree } from '#tree/client';
import { DIRTY_COALESCE_MS } from '#tree/events';
import { ingestNode } from '#tree/rebase';
// tabTokenInput spreads into every watch-registering/releasing input so the
// server keys watch ownership to THIS tab (core-anz4.12/28).
import { tabTokenInput, trpc } from '#tree/trpc';
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

// ── Read resources (ns6p.4 §3.3-1, invariant 17) ──
// A read is identified by path + normalized query — NOT parent path alone, so
// two queries over one parent don't share a generation counter. Key order in
// the query object must not fork resources (kept local: core's stableJson is
// behind the curated exports map — no public door, qvrt).

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return v;
}

const resourceKey = (kind: 'get' | 'ls', path: string, query?: Record<string, unknown>): string =>
  `${kind}\u0000${path}\u0000${query ? JSON.stringify(sortKeysDeep(query)) : ''}`;

// A response that lost its generation is dropped — latest-issued wins, never
// last-settled. Silent in prod (the drop IS the correct behavior), loud in dev.
function dropStale(kind: string, path: string): void {
  if (import.meta.env?.DEV) {
    console.warn(`[tree-source] stale ${kind} response for ${path} dropped (superseded read)`);
  }
}

// End a tracked read exactly once (a throw inside .then falls into .catch).
function readEnder(end: (applied: boolean) => boolean): (applied: boolean) => boolean {
  let ended = false;
  return (applied) => ended ? false : ((ended = true), end(applied));
}

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

  // Monotonic generation per read resource (invariant 17).
  private readGens = new Map<string, number>();
  // Active listing resource keys per parent — the §4.2 multi-query gate.
  private activeChildKeys = new Map<string, Map<string, number>>();

  private issueRead(key: string): number {
    const gen = (this.readGens.get(key) ?? 0) + 1;
    this.readGens.set(key, gen);
    return gen;
  }

  private isCurrentRead(key: string, gen: number): boolean {
    return this.readGens.get(key) === gen;
  }

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
    const nextCursor = cache.getChildrenNextCursor(path);
    const error = cache.getChildrenError(path);
    const prev = this.childSnaps.get(path);
    if (
      prev
      && prev.data === data
      && prev.phase === phase
      && prev.total === total
      && prev.truncated === truncated
      && prev.nextCursor === nextCursor
      && prev.error === error
    ) {
      return prev;
    }
    const next: ChildrenSnapshot = { data, phase, total, truncated, nextCursor, error };
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
    const key = resourceKey('get', path);
    let cancelled = false;

    // Coalesced reconverge after a set/remove overlapped an in-flight get
    // (F2, inv.17/18): presence/absence isn't rev-ordered, refetch decides.
    let overlapTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleOverlapRefetch = () => {
      if (overlapTimer || cancelled) return;
      overlapTimer = setTimeout(() => {
        overlapTimer = null;
        if (!cancelled) fetchOnce();
      }, DIRTY_COALESCE_MS);
    };

    const fetchOnce = () => {
      if (cancelled) return;
      const gen = this.issueRead(key);
      cache.setPathStatus(path, 'loading');
      cache.beginPathRead(path);
      const end = readEnder((a) => cache.endPathRead(path, a));
      trpc.get.query({ path, watch: watching, ...(watching ? tabTokenInput : {}) })
        .then((n) => {
          const applied = !cancelled && this.isCurrentRead(key, gen);
          const overlapped = end(applied);
          if (!applied) { if (!cancelled) dropStale('get', path); return; }
          if (n) cache.put(ingestNode(n));
          // Absent response that raced a create event (F2): the older 'absent'
          // must not delete the created node — the re-get below decides.
          else if (!overlapped) cache.markPathMissing(path);
          if (overlapped) scheduleOverlapRefetch();
        })
        .catch((err: unknown) => {
          end(false);
          if (cancelled || !this.isCurrentRead(key, gen)) return;
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
        if (overlapTimer) { clearTimeout(overlapTimer); overlapTimer = null; }
        unsubReset();
        if (watching && unrefWatch(this.pathWatchRefs, path)) {
          // core-m77: failure here means the server-side watch leaks — surface it.
          trpc.unwatch.mutate({ paths: [path], ...tabTokenInput })
            .catch((e: unknown) => console.error('[tree-source] unwatch failed:', path, e));
        }
      },
    };
  }

  // ── mountChildren: fetch + paginate + watch + reset listener ──

  mountChildren(path: string, opts?: ChildrenOpts): ChildrenHandle {
    let cancelled = false;
    cache.retainChildSubscriber(path);

    const key = resourceKey('ls', path, opts?.query);
    // §4.2 gate (F5): the SERVER coexists query handles (slice 5) but children
    // state here is parent-keyed — two LIVE query streams would fight over one
    // cache slot. Only the first-mounted resource key stays live; a different-
    // query mount reads without watch registration until a remount after the
    // first unmounts (core-jsh1 lifts this with a resource-keyed cache).
    let keys = this.activeChildKeys.get(path);
    if (!keys) { keys = new Map(); this.activeChildKeys.set(path, keys); }
    const firstKey = keys.keys().next().value;
    const gated = firstKey !== undefined && firstKey !== key;
    if (gated) {
      console.error(`[tree-source] concurrent listings with different queries on ${path} — client cache is parent-keyed; this mount reads non-live until the first unmounts (core-jsh1)`);
    }
    keys.set(key, (keys.get(key) ?? 0) + 1);

    const watching = !gated && !!(opts?.watch || opts?.watchNew);
    if (watching) refWatch(this.childrenWatchRefs, path);

    // Coalesced reconverge after an event overlapped an in-flight page
    // (invariant 19): membership isn't rev-ordered, refetch decides.
    let overlapTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleOverlapRefetch = () => {
      if (overlapTimer || cancelled) return;
      overlapTimer = setTimeout(() => {
        overlapTimer = null;
        if (!cancelled) refetch();
      }, DIRTY_COALESCE_MS);
    };

    // Replace-window fetch shared by initial and refetch. Every listing uses
    // nextCursor as its only "more available" signal.
    const fetchWindow = (limit: number, phase: 'initial' | 'refetch') => {
      const gen = this.issueRead(key);
      cache.setChildrenPhase(path, phase);
      cache.beginChildrenRead(path);
      const end = readEnder((a) => cache.endChildrenRead(path, a));
      trpc.getChildren
        .query({ path, limit, query: opts?.query, ...(watching ? { watch: opts?.watch, watchNew: opts?.watchNew, ...tabTokenInput } : {}) })
        .then((result: { items: NodeData[]; total: number; truncated?: boolean; nextCursor?: string }) => {
          const applied = !cancelled && this.isCurrentRead(key, gen);
          const overlapped = end(applied);
          if (!applied) { if (!cancelled) dropStale('ls', path); return; }
          cache.replaceChildren(path, result.items.map(ingestNode));
          cache.setChildrenTotal(path, result.total);
          cache.setChildrenTruncated(path, !!result.truncated);
          cache.setChildrenNextCursor(path, result.nextCursor ?? null);
          cache.setChildrenError(path, null);
          cache.setChildrenPhase(path, 'ready');
          if (overlapped) scheduleOverlapRefetch();
        })
        .catch((err: unknown) => {
          end(false);
          if (cancelled || !this.isCurrentRead(key, gen)) return;
          cache.setChildrenError(path, err instanceof Error ? err : new Error(String(err)));
          cache.setChildrenPhase(path, 'error');
        });
    };

    const initialFetch = () => {
      if (cancelled) return;
      const limit = cache.lockChildPageSize(path, opts?.limit ?? DEFAULT_PAGE_SIZE);
      const hasAuthoritative = cache.hasChildrenCollectionLoaded(path);
      fetchWindow(limit, hasAuthoritative ? 'refetch' : 'initial');
    };

    const refetch = () => {
      if (cancelled) return;
      // Reload the currently-loaded window (preserves scroll position).
      const windowSize = cache.getLoadedCount(path)
        || cache.getChildPageSize(path)
        || DEFAULT_PAGE_SIZE;
      fetchWindow(windowSize, 'refetch');
    };

    const loadMore = () => {
      if (cancelled) return;
      if (cache.getChildrenPhase(path) === 'append') return;
      const pageSize = cache.getChildPageSize(path) ?? DEFAULT_PAGE_SIZE;
      const nextCursor = cache.getChildrenNextCursor(path);

      if (nextCursor === null) return;
      // Pages share the window's generation lane: a refetch issued mid-flight
      // supersedes this page — appending it would corrupt the fresh window.
      const gen = this.issueRead(key);
      cache.setChildrenPhase(path, 'append');
      cache.beginChildrenRead(path);
      const end = readEnder((a) => cache.endChildrenRead(path, a));
      trpc.getChildren
        .query({ path, limit: pageSize, cursor: nextCursor, query: opts?.query })
        .then((result: { items: NodeData[]; nextCursor?: string }) => {
          const applied = !cancelled && this.isCurrentRead(key, gen);
          const overlapped = end(applied);
          if (!applied) { if (!cancelled) dropStale('loadMore', path); return; }
          cache.appendChildren(path, result.items.map(ingestNode));
          cache.setChildrenNextCursor(path, result.nextCursor ?? null);
          cache.setChildrenTotal(path, cache.getLoadedCount(path));
          cache.setChildrenPhase(path, 'ready');
          if (overlapped) scheduleOverlapRefetch();
        })
        .catch((err: unknown) => {
          end(false);
          if (cancelled || !this.isCurrentRead(key, gen)) return;
          cache.setChildrenError(path, err instanceof Error ? err : new Error(String(err)));
          cache.setChildrenPhase(path, 'error');
        });
    };

    initialFetch();
    const unsubReset = cache.subscribeSSEGen(initialFetch);
    // F1 (inv.16/19): a vp-dirty on a SETTLED listing refetches through this
    // mount's own coalesced lane — the in-flight overlap flag alone is a no-op
    // when idle. Gated mounts stay passive: their refetch would fight the live
    // query's cache slot.
    const unsubDirty = gated ? null : cache.subscribeChildrenDirty(path, scheduleOverlapRefetch);

    return {
      refetch,
      loadMore,
      dispose: () => {
        cancelled = true;
        if (overlapTimer) { clearTimeout(overlapTimer); overlapTimer = null; }
        const active = this.activeChildKeys.get(path);
        if (active) {
          const n = (active.get(key) ?? 0) - 1;
          if (n <= 0) active.delete(key); else active.set(key, n);
          if (active.size === 0) this.activeChildKeys.delete(path);
        }
        unsubDirty?.();
        unsubReset();
        cache.releaseChildSubscriber(path);
        if (watching && unrefWatch(this.childrenWatchRefs, path)) {
          // core-m77: failure here means the server-side children watch leaks — surface it.
          trpc.unwatchChildren.mutate({ paths: [path], ...tabTokenInput })
            .catch((e: unknown) => console.error('[tree-source] unwatchChildren failed:', path, e));
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
