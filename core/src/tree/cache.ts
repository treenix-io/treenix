// Treenity Cache Tree — Layer 1
// Write-populate tree cache wrapping any Tree.
// Tree structure mirrors path hierarchy — O(depth) navigation, O(1) subtree drop.
// Populate on read AND write. Inflight dedup prevents thundering herd.

import type { NodeData } from '#core';
import { type Tree, treeEnsure, treeNavigate, type TreeNode } from './index';
import { createInflight } from './inflight';
import { patchViaSet } from './patch';

// Recursively freeze plain objects/arrays. Callers must clone before mutating —
// structuredClone/applyOps/patchViaSet already do. Prevents external mutation
// leaking into the cache and bypassing the write pipeline.
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as any)[key]);
  return value;
}

export function withCache(tree: Tree): Tree {
  const root: TreeNode<NodeData> = { children: new Map() };
  const dedup = createInflight<NodeData | undefined>();

  const wrapper: Tree = {
    async get(path, ctx) {
      const cached = treeNavigate(root, path);
      if (cached?.data !== undefined) return cached.data;
      return dedup(path, async () => {
        const node = await tree.get(path, ctx);
        if (node) treeEnsure(root, node.$path).data = deepFreeze(node);
        return node;
      });
    },

    async getChildren(path, opts, ctx) {
      const result = await tree.getChildren(path, opts, ctx);
      for (const node of result.items) treeEnsure(root, node.$path).data = deepFreeze(node);
      return result;
    },

    async set(node, ctx) {
      await tree.set(node, ctx);
      // Write-populate: re-read to capture $rev bump, warm cache for subscribers
      const fresh = await tree.get(node.$path, ctx);
      if (fresh) treeEnsure(root, node.$path).data = deepFreeze(fresh);
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
