// Treenix Cache Tree — Layer 1
// Flat path-keyed FIFO cache wrapping any Tree.
// Populate on read AND write. Inflight dedup prevents thundering herd.

import type { NodeData } from '#core';
import { createBoundedCache } from '#util/bounded-cache';
import { type Tree, type TreeEvent, type TreeWatchOpts, type TreeWatchScope } from './index';
import { createInflight } from './inflight';
import { patchViaSet } from './patch';

// Cache stores live refs. Callers MUST clone before mutating —
// patchViaSet / applyOps / set() already do. Previously `deepFreeze`d on write
// for belt-and-suspenders protection, but that broke upper layers that need
// to attach metadata (e.g. `@treenx/react` stamps $key/$node symbols on
// returned nodes) — `Object.defineProperty` throws on frozen objects.

const DEFAULT_MAX = 5000;

/** Cache wrapper with an additional `invalidate(path)` for external use.
 *  External-watch consumers call invalidate before forwarding events through
 *  the subscription bus, so subsequent reads (e.g. by watch-filter for ACL
 *  computation) see fresh data instead of stale cached nodes. */
export type CachedTree = Tree & {
  invalidate(path: string): void;
  invalidateAll(): void;
};

export function withCache(tree: Tree, max = DEFAULT_MAX): CachedTree {
  const cache = createBoundedCache<string, NodeData>(max);
  const dedup = createInflight<NodeData | undefined>();
  // Single monotonic epoch — bumped on EVERY invalidate / invalidateAll.
  // get() snapshots it at read start; the post-resolve check refuses to
  // populate cache if it moved. Vs. a per-path Map, this is bounded by
  // construction (one integer, no eviction race) and avoids the bug where
  // a per-path entry gets FIFO-evicted before the in-flight read resolves.
  // Cost: an unrelated invalidate(other-path) disqualifies any concurrent
  // in-flight get's cache write. External invalidations are rare; the cost
  // is "next read repopulates", not correctness.
  let invalidateEpoch = 0;

  const wrapper: CachedTree = {
    invalidate(path) { cache.delete(path); invalidateEpoch++; },
    invalidateAll() { cache.clear(); invalidateEpoch++; },

    async get(path, ctx) {
      const cached = cache.get(path);
      if (cached !== undefined) return cached;
      const startEpoch = invalidateEpoch;
      // Inflight dedup key includes the epoch — a caller arriving AFTER
      // invalidate gets a different key, so it does NOT join the
      // pre-invalidate in-flight read (which would return a stale value).
      const inflightKey = `${path}@${startEpoch}`;
      return dedup(inflightKey, async () => {
        const node = await tree.get(path, ctx);
        // If any invalidate fires DURING this fetch, don't repopulate cache
        // — the value we just read is potentially stale.
        if (node && invalidateEpoch === startEpoch) cache.set(node.$path, node);
        return node;
      });
    },

    async getChildren(path, opts, ctx) {
      const startEpoch = invalidateEpoch;
      const result = await tree.getChildren(path, opts, ctx);
      if (invalidateEpoch === startEpoch) {
        for (const node of result.items) cache.set(node.$path, node);
      }
      return result;
    },

    ...(tree.scanChildren ? {
      async *scanChildren(parent: string, opts?: Parameters<NonNullable<Tree['scanChildren']>>[1], ctx?: unknown) {
        const startEpoch = invalidateEpoch;
        for await (const entry of tree.scanChildren!(parent, opts, ctx)) {
          if (invalidateEpoch === startEpoch) cache.set(entry.node.$path, entry.node);
          yield entry;
        }
      },
    } : {}),

    async set(node, ctx) {
      await tree.set(node, ctx);
      // Write-populate: re-read to capture $rev bump, warm cache for subscribers
      const fresh = await tree.get(node.$path, ctx);
      if (fresh) cache.set(node.$path, fresh);
    },

    async remove(path, ctx) {
      const result = await tree.remove(path, ctx);
      cache.delete(path);
      return result;
    },

    async patch(path, ops, ctx) {
      return patchViaSet(wrapper, path, ops, ctx);
    },

    // Cache invalidation via watch — for the federation-client case where
    // withCache wraps a remote tree. Every data event evicts the path so the
    // next get re-fetches; reconnect{preserved:false} clears the whole cache.
    // The server-side topology `withSubscriptions(withCache(...))` doesn't
    // exercise this — writes go through withCache.set which keeps the cache
    // consistent without needing watch. Only forwarded when inner exposes
    // watch — bare adapters (Mongo, etc.) stay opt-in.
    ...(tree.watch ? {
      watch(scope: TreeWatchScope, opts?: TreeWatchOpts, ctx?: unknown): AsyncIterable<TreeEvent> {
        const inner = tree.watch!(scope, opts, ctx);
        async function* wrapped(): AsyncIterable<TreeEvent> {
          for await (const event of inner) {
            // Route through wrapper.invalidate{,All} so the generation +
            // warming-epoch counters bump consistently. Raw cache.delete
            // would silently skip those, leaving in-flight reads free to
            // repopulate the just-cleared slot with stale data.
            if (event.type === 'reconnect') {
              if (!event.preserved) wrapper.invalidateAll();
            } else {
              wrapper.invalidate(event.path);
            }
            yield event;
          }
        }
        return wrapped();
      },
    } : {}),
  };
  return wrapper;
}
