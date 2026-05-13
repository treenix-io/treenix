// Treenix Cache Tree — Layer 1
// Flat path-keyed FIFO cache wrapping any Tree.
// Populate on read AND write. Inflight dedup prevents thundering herd.

import type { NodeData } from '#core';
import { createBoundedCache } from '#util/bounded-cache';
import { type Tree } from './index';
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
  };
  return wrapper;
}
