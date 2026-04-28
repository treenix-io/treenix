// Treenix Cache Tree — Layer 1
// Write-populate tree cache wrapping any Tree.
// Tree structure mirrors path hierarchy — O(depth) navigation, O(1) subtree drop.
// Populate on read AND write. Inflight dedup prevents thundering herd.

import type { NodeData } from '#core';
import { type Tree, treeEnsure, treeNavigate, type TreeNode } from './index';
import { createInflight } from './inflight';
import { patchViaSet } from './patch';

// Cache stores live refs. Callers MUST clone before mutating —
// patchViaSet / applyOps / set() already do. Previously `deepFreeze`d on write
// for belt-and-suspenders protection, but that broke upper layers that need
// to attach metadata (e.g. `@treenx/react` stamps $key/$node symbols on
// returned nodes) — `Object.defineProperty` throws on frozen objects.

export function withCache(tree: Tree): Tree {
  const root: TreeNode<NodeData> = { children: new Map() };
  const dedup = createInflight<NodeData | undefined>();

  const wrapper: Tree = {
    async get(path, ctx) {
      const cached = treeNavigate(root, path);
      if (cached?.data !== undefined) return cached.data;
      return dedup(path, async () => {
        const node = await tree.get(path, ctx);
        if (node) treeEnsure(root, node.$path).data = node;
        return node;
      });
    },

    async getChildren(path, opts, ctx) {
      const result = await tree.getChildren(path, opts, ctx);
      for (const node of result.items) treeEnsure(root, node.$path).data = node;
      return result;
    },

    async set(node, ctx) {
      await tree.set(node, ctx);
      // Write-populate: re-read to capture $rev bump, warm cache for subscribers
      const fresh = await tree.get(node.$path, ctx);
      if (fresh) treeEnsure(root, node.$path).data = fresh;
    },

    async remove(path, ctx) {
      const result = await tree.remove(path, ctx);
      const cached = treeNavigate(root, path);
      if (cached) cached.data = undefined;
      return result;
    },

    async patch(path, ops, ctx) {
      return patchViaSet(wrapper, path, ops, ctx);
    },
  };
  return wrapper;
}
