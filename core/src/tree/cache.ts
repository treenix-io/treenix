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
  // Per-path generation counter. Bumped on every invalidate / invalidateAll
  // (the latter bumps a wildcard `*`). Any read started before the bump
  // captures the pre-bump value and refuses to populate the cache when it
  // completes — closes the in-flight stale-read race: read starts, external
  // write invalidates, read resolves with the OLD node, would otherwise
  // repopulate cache with stale data.
  const gen = new Map<string, number>();
  let allGen = 0;

  function bump(path: string) {
    gen.set(path, (gen.get(path) ?? 0) + 1);
  }
  function snapshot(path: string): { path: number; all: number } {
    return { path: gen.get(path) ?? 0, all: allGen };
  }
  function stale(path: string, snap: { path: number; all: number }): boolean {
    return (gen.get(path) ?? 0) !== snap.path || allGen !== snap.all;
  }

  const wrapper: CachedTree = {
    // path invalidate ALSO bumps allGen so concurrent collection reads
    // (getChildren/scanChildren) don't repopulate the cache with entries
    // captured before this invalidation. Coarser than per-path tracking,
    // but the cost is a missed warming opportunity (next read repopulates)
    // — never a correctness bug. Without this, a getChildren in-flight at
    // invalidate time would write back the stale node for the invalidated
    // path during its post-fetch warming loop.
    invalidate(path) { cache.delete(path); bump(path); allGen++; },
    invalidateAll() { cache.clear(); allGen++; },

    async get(path, ctx) {
      const cached = cache.get(path);
      if (cached !== undefined) return cached;
      const snap = snapshot(path);
      // Include generation in the inflight dedup key — a caller arriving
      // AFTER invalidate must NOT join a pre-invalidate in-flight read
      // (which would return the stale value about to be discarded). The
      // generation bump means the key differs, so a fresh inflight starts.
      const inflightKey = `${path}@${snap.path}.${snap.all}`;
      return dedup(inflightKey, async () => {
        const node = await tree.get(path, ctx);
        // Belt-and-suspenders: if invalidate fires DURING this fetch, the
        // result is stale → don't repopulate. (Inflight key already filters
        // post-invalidate JOINERS; this catches the original starter.)
        if (node && !stale(path, snap)) cache.set(node.$path, node);
        return node;
      });
    },

    async getChildren(path, opts, ctx) {
      // Snapshot allGen BEFORE the fetch — any invalidate/invalidateAll
      // that fires during the in-flight read bumps allGen, and we skip
      // warming entirely. Conservative: a single unrelated invalidate
      // disqualifies the whole batch. Cost = next read repopulates;
      // correctness wins over a missed warming opportunity.
      const startAllGen = allGen;
      const result = await tree.getChildren(path, opts, ctx);
      if (allGen === startAllGen) {
        for (const node of result.items) cache.set(node.$path, node);
      }
      return result;
    },

    // Scan-side cache warming with the same guard. Entries are still
    // yielded (caller sees data); only the cache population is skipped
    // for entries observed AFTER an invalidation in this stream.
    ...(tree.scanChildren ? {
      async *scanChildren(parent: string, opts?: Parameters<NonNullable<Tree['scanChildren']>>[1], ctx?: unknown) {
        const startAllGen = allGen;
        for await (const entry of tree.scanChildren!(parent, opts, ctx)) {
          if (allGen === startAllGen) cache.set(entry.node.$path, entry.node);
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
            if (event.type === 'reconnect') {
              if (!event.preserved) cache.clear();
            } else {
              cache.delete(event.path);
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
