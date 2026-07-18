// ClientTreeSource — the production TreeSource used in the SPA.
// Wraps the in-memory cache + tRPC transport + SSE generation.
// All side effects (fetch, watch ref-counting, reset re-fetch) live here so
// the React hooks become thin presenters and the SSR ServerTreeSource can
// implement the same interface without touching tRPC or SSE.
//
// Reads go through the read-track door (ns6p.4 F1): generations, overlap
// consumption and ingest routing live THERE; this class owns presentation
// state (status/phase) and mount lifecycles. Server holds count in the
// tab-global holds registry (F5) — never released directly from here.

import type { NodeData } from '@treenx/core';
// Use the package-internal alias (#tree/...) — NOT relative './cache' — so
// Vite deduplicates with hooks.ts's import. Two URLs for the same file
// produce two ESM module instances, two cache singletons, broken reactivity.
import * as cache from '#tree/cache';
import { tree as clientTree } from '#tree/client';
import { acquireChildrenHold, acquireHold, acquireHolds, releaseChildrenHold, releaseHold } from '#tree/holds';
import { applyListingWindow, DIRTY_COALESCE_MS, resourceKey, trackedGet, trackedList } from '#tree/read-track';
import { ingestNode } from '#tree/rebase';
// tabTokenInput spreads into every watch-registering input so the server keys
// watch ownership to THIS tab (core-anz4.12/28).
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

type WirePage = { items: NodeData[]; total: number; truncated?: boolean; nextCursor?: string };

// ── One-shot tracked reads (door consumers shared by UI chrome) ──
// EditorSidebar / ActionCards read outside the mount lifecycle; these helpers
// keep every such read inside the door (F1) and every hold counted (F5).

/** Tracked watch-registering exact get. Returns the fetched node; callers
 *  decide hold accounting — an absent path holds no server watch (peer pin). */
export async function trackedWatchGet(path: string): Promise<NodeData | null> {
  const o = await trackedGet(path, () => trpc.get.query({ path, watch: true, ...tabTokenInput }));
  if (o.error !== undefined) throw o.error;
  return o.node;
}

/** Post-action / post-create refresh: tracked watch-get with TRANSIENT hold
 *  accounting — co-held (Inspector on the same node) → the registration
 *  stays; alone → the release fires and the get's watch never leaks. */
export async function refreshWatchedNode(path: string): Promise<void> {
  const node = await trackedWatchGet(path);
  if (node) { acquireHold(path); releaseHold(path); }
}

/** Tracked watch-registering listing (sidebar dirs). Registers the children
 *  hold + one exact hold per loaded item; returns the item paths so collapse
 *  releases exactly what this load acquired. */
export async function loadWatchedListing(parent: string): Promise<string[]> {
  let loaded: string[] = [];
  const o = await trackedList(
    parent,
    undefined,
    // Direct trpc, not tree.getChildren: remote-tree no longer forwards watch
    // flags (r4-M4) — live registration must carry the tab token.
    (): Promise<WirePage> => trpc.getChildren.query({ path: parent, watch: true, watchNew: true, ...tabTokenInput }),
    (result) => {
      // Full window settle (phase included): this read may have superseded a
      // useChildren mount's fetch of the same parent — leaving phase unsettled
      // would strand that mount's presentation.
      applyListingWindow(parent, result);
      loaded = result.items.map((n) => n.$path);
    },
  );
  if (o.error !== undefined) {
    if (o.current) {
      cache.setChildrenError(parent, o.error instanceof Error ? o.error : new Error(String(o.error)));
      cache.setChildrenPhase(parent, 'error');
    }
    throw o.error;
  }
  acquireChildrenHold(parent);
  acquireHolds(loaded);
  return loaded;
}

export class ClientTreeSource implements TreeSource {
  // Stable-reference snapshot caches. useSyncExternalStore requires the same
  // object identity until the underlying state actually changes.
  private pathSnaps = new Map<string, PathSnapshot>();
  private childSnaps = new Map<string, ChildrenSnapshot>();

  // Active listing resource keys per parent — the §4.2 multi-query gate.
  private activeChildKeys = new Map<string, Map<string, number>>();

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
      cache.setPathStatus(path, 'loading');
      void trackedGet(
        path,
        () => trpc.get.query({ path, watch: watching, ...(watching ? tabTokenInput : {}) }),
        { isCancelled: () => cancelled, onOverlap: scheduleOverlapRefetch },
      ).then((o) => {
        // A superseded read's failure must not clobber the fresher read's state.
        if (o.error === undefined || cancelled || !o.current) return;
        cache.setPathError(path, o.error instanceof Error ? o.error : new Error(String(o.error)));
        cache.setPathStatus(path, 'error');
      });
    };

    fetchOnce();
    if (watching) acquireHold(path);
    // SSE reconnect → re-fetch (preserved=false means generation bumped).
    const unsubReset = cache.subscribeSSEGen(fetchOnce);

    return {
      refetch: fetchOnce,
      dispose: () => {
        cancelled = true;
        if (overlapTimer) { clearTimeout(overlapTimer); overlapTimer = null; }
        unsubReset();
        if (watching) releaseHold(path);
      },
    };
  }

  // ── mountChildren: fetch + paginate + watch + reset listener ──

  mountChildren(path: string, opts?: ChildrenOpts): ChildrenHandle {
    const key = resourceKey('ls', path, opts?.query);
    // §4.2 gate (F5/F6): the SERVER coexists query handles (slice 5) but
    // children state here is parent-keyed — two LIVE query streams would fight
    // over one cache slot. Only the first-mounted resource key stays live; a
    // different-query mount is served from a per-mount local snapshot and
    // never touches the shared cache (core-jsh1 lifts this with a
    // resource-keyed cache).
    let keys = this.activeChildKeys.get(path);
    if (!keys) { keys = new Map(); this.activeChildKeys.set(path, keys); }
    const firstKey = keys.keys().next().value;
    const gated = firstKey !== undefined && firstKey !== key;
    if (gated) {
      console.error(`[tree-source] concurrent listings with different queries on ${path} — client cache is parent-keyed; this mount reads non-live into a local snapshot until the first unmounts (core-jsh1)`);
    }
    keys.set(key, (keys.get(key) ?? 0) + 1);

    const releaseKey = () => {
      const active = this.activeChildKeys.get(path);
      if (!active) return;
      const n = (active.get(key) ?? 0) - 1;
      if (n <= 0) active.delete(key); else active.set(key, n);
      if (active.size === 0) this.activeChildKeys.delete(path);
    };

    if (gated) return this.mountChildrenGated(path, opts, releaseKey);

    let cancelled = false;
    cache.retainChildSubscriber(path);

    const watching = !!(opts?.watch || opts?.watchNew);
    if (watching) acquireChildrenHold(path);

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

    const settleError = (err: unknown) => {
      cache.setChildrenError(path, err instanceof Error ? err : new Error(String(err)));
      cache.setChildrenPhase(path, 'error');
    };

    // Replace-window fetch shared by initial and refetch. Every listing uses
    // nextCursor as its only "more available" signal.
    const fetchWindow = (limit: number, phase: 'initial' | 'refetch') => {
      cache.setChildrenPhase(path, phase);
      void trackedList(
        path,
        opts?.query,
        (): Promise<WirePage> => trpc.getChildren
          .query({ path, limit, query: opts?.query, ...(watching ? { watch: opts?.watch, watchNew: opts?.watchNew, ...tabTokenInput } : {}) }),
        (result) => applyListingWindow(path, result),
        { isCancelled: () => cancelled, onOverlap: scheduleOverlapRefetch },
      ).then((o) => {
        if (o.error === undefined || cancelled || !o.current) return;
        settleError(o.error);
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
      // Pages share the window's resource key: a refetch issued mid-flight
      // supersedes this page — appending it would corrupt the fresh window.
      cache.setChildrenPhase(path, 'append');
      void trackedList(
        path,
        opts?.query,
        (): Promise<WirePage> => trpc.getChildren
          .query({ path, limit: pageSize, cursor: nextCursor, query: opts?.query }),
        (result) => {
          cache.appendChildren(path, result.items);
          cache.setChildrenNextCursor(path, result.nextCursor ?? null);
          cache.setChildrenTotal(path, cache.getLoadedCount(path));
          cache.setChildrenPhase(path, 'ready');
        },
        { isCancelled: () => cancelled, onOverlap: scheduleOverlapRefetch },
      ).then((o) => {
        if (o.error === undefined || cancelled || !o.current) return;
        settleError(o.error);
      });
    };

    initialFetch();
    const unsubReset = cache.subscribeSSEGen(initialFetch);
    // F1 (inv.16/19): a vp-dirty on a SETTLED listing refetches through this
    // mount's own coalesced lane — the in-flight overlap flag alone is a no-op
    // when idle.
    const unsubDirty = cache.subscribeChildrenDirty(path, scheduleOverlapRefetch);

    return {
      refetch,
      loadMore,
      dispose: () => {
        cancelled = true;
        if (overlapTimer) { clearTimeout(overlapTimer); overlapTimer = null; }
        releaseKey();
        unsubDirty();
        unsubReset();
        cache.releaseChildSubscriber(path);
        if (watching) releaseChildrenHold(path);
      },
    };
  }

  // §4.2 fail-closed gate (F6): the gated mount's reads live entirely in a
  // per-mount snapshot — no shared cache writes, no shared read tracking (its
  // begin/end would consume the LIVE query's overlap flags), no watch
  // registration, no page-size lock. Its subscriber renders this lane via the
  // handle's own getSnapshot/subscribe.
  private mountChildrenGated(
    path: string,
    opts: ChildrenOpts | undefined,
    releaseKey: () => void,
  ): ChildrenHandle {
    let cancelled = false;
    let localGen = 0;

    let snap: ChildrenSnapshot = {
      data: [], phase: 'idle', total: null, truncated: null, nextCursor: null, error: null,
    };
    const subs = new Set<() => void>();
    const publish = (next: Partial<ChildrenSnapshot>) => {
      snap = { ...snap, ...next };
      for (const cb of subs) cb();
    };

    const fetchWindow = (phase: 'initial' | 'refetch') => {
      if (cancelled) return;
      const gen = ++localGen;
      publish({ phase });
      trpc.getChildren
        .query({ path, limit: opts?.limit ?? DEFAULT_PAGE_SIZE, query: opts?.query })
        .then((result: WirePage) => {
          if (cancelled || gen !== localGen) return;
          publish({
            // ingest keeps payloads non-regressing vs cache/overlays without
            // touching membership (inv.18/28); plain map, no cache.put.
            data: result.items.map(ingestNode),
            total: result.total,
            truncated: !!result.truncated,
            nextCursor: result.nextCursor ?? null,
            error: null,
            phase: 'ready',
          });
        })
        .catch((err: unknown) => {
          if (cancelled || gen !== localGen) return;
          publish({ error: err instanceof Error ? err : new Error(String(err)), phase: 'error' });
        });
    };

    const loadMore = () => {
      if (cancelled || snap.phase === 'append' || snap.nextCursor === null) return;
      const gen = ++localGen;
      const cursor = snap.nextCursor;
      publish({ phase: 'append' });
      trpc.getChildren
        .query({ path, limit: opts?.limit ?? DEFAULT_PAGE_SIZE, cursor, query: opts?.query })
        .then((result: WirePage) => {
          if (cancelled || gen !== localGen) return;
          const seen = new Set(snap.data.map((n) => n.$path));
          const fresh = result.items.map(ingestNode).filter((n) => !seen.has(n.$path));
          const data = [...snap.data, ...fresh];
          publish({ data, total: data.length, nextCursor: result.nextCursor ?? null, phase: 'ready' });
        })
        .catch((err: unknown) => {
          if (cancelled || gen !== localGen) return;
          publish({ error: err instanceof Error ? err : new Error(String(err)), phase: 'error' });
        });
    };

    fetchWindow('initial');
    const unsubReset = cache.subscribeSSEGen(() => fetchWindow('refetch'));

    return {
      refetch: () => fetchWindow('refetch'),
      loadMore,
      getSnapshot: () => snap,
      subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
      dispose: () => {
        cancelled = true;
        releaseKey();
        unsubReset();
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
