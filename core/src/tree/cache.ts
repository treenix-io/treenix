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

export function withCache(tree: Tree, max = DEFAULT_MAX): Tree {
  const cache = createBoundedCache<string, NodeData>(max);
  const dedup = createInflight<NodeData | undefined>();

  const wrapper: Tree = {
    async get(path, ctx) {
      const cached = cache.get(path);
      if (cached !== undefined) return cached;
      return dedup(path, async () => {
        const node = await tree.get(path, ctx);
        if (node) cache.set(node.$path, node);
        return node;
      });
    },

    async getChildren(path, opts, ctx) {
      const result = await tree.getChildren(path, opts, ctx);
      for (const node of result.items) cache.set(node.$path, node);
      return result;
    },

    // Scan-side cache warming: every yielded entry populates the lookup
    // cache, so a follow-up get(node.$path) on the same path is free.
    // Only exposed when the inner tree supports scanChildren — wire-facing
    // (RPC) trees don't.
    ...(tree.scanChildren ? {
      async *scanChildren(parent: string, opts?: Parameters<NonNullable<Tree['scanChildren']>>[1], ctx?: unknown) {
        for await (const entry of tree.scanChildren!(parent, opts, ctx)) {
          cache.set(entry.node.$path, entry.node);
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
