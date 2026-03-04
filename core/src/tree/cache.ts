// Treenity Cache Tree — Layer 1
// Write-populate tree cache wrapping any Tree.
// Tree structure mirrors path hierarchy — O(depth) navigation, O(1) subtree drop.
// Populate on read AND write. Inflight dedup prevents thundering herd.

import type { NodeData } from '#core';
import { type Tree, treeEnsure, treeNavigate, type TreeNode } from './index';
import { createInflight } from './inflight';

export function withCache(store: Tree): Tree {
  const root: TreeNode<NodeData> = { children: new Map() };
  const dedup = createInflight<NodeData | undefined>();

  return {
    async get(path, ctx) {
      const cached = treeNavigate(root, path);
      if (cached?.data !== undefined) return cached.data;
      return dedup(path, async () => {
        const node = await store.get(path, ctx);
        if (node) treeEnsure(root, node.$path).data = node;
        return node;
      });
    },

    async getChildren(path, opts, ctx) {
      const result = await store.getChildren(path, opts, ctx);
      for (const node of result.items) treeEnsure(root, node.$path).data = node;
      return result;
    },

    async set(node, ctx) {
      await store.set(node, ctx);
      // Write-populate: re-read to capture $rev bump, warm cache for subscribers
      const fresh = await store.get(node.$path, ctx);
      treeEnsure(root, node.$path).data = fresh;
    },

    async remove(path, ctx) {
      const result = await store.remove(path, ctx);
      const cached = treeNavigate(root, path);
      if (cached) cached.data = undefined;
      return result;
    },

    async patch(path, ops, ctx) {
      await store.patch(path, ops, ctx);
      const fresh = await store.get(path, ctx);
      treeEnsure(root, path).data = fresh;
    },
  };
}
