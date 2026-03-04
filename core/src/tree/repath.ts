// Path-rewriting Tree combinator — mounts a remote tree at a local prefix.
// Like Linux mount: remote /strategies/x ↔ local /app/live/strategies/x
//
// localBase:  where the tree is mounted in our namespace (e.g. '/app/live')
// remoteBase: root of the remote tree to use (e.g. '/', or '/data' for a subtree)

import type { NodeData } from '#core';
import type { Page, Tree } from './index';

export function createRepathTree(inner: Tree, localBase: string, remoteBase: string = '/'): Tree {
  // Normalize: strip trailing slashes, handle root
  const lb = localBase === '/' ? '' : localBase;
  const rb = remoteBase === '/' ? '' : remoteBase;

  function toRemote(localPath: string): string {
    const rest = localPath.slice(lb.length);
    return rb + rest || '/';
  }

  function toLocal(remotePath: string): string {
    const rest = remotePath.slice(rb.length);
    return lb + rest || '/';
  }

  function remapNode(node: NodeData): NodeData {
    return { ...node, $path: toLocal(node.$path) };
  }

  function remapPage(page: Page<NodeData>): Page<NodeData> {
    return { ...page, items: page.items.map(remapNode) };
  }

  return {
    get: async (path, ctx) => {
      const node = await inner.get(toRemote(path), ctx);
      return node ? remapNode(node) : undefined;
    },

    getChildren: async (path, opts, ctx) => {
      const page = await inner.getChildren(toRemote(path), opts, ctx);
      return remapPage(page);
    },

    set: (node, ctx) =>
      inner.set({ ...node, $path: toRemote(node.$path) }, ctx),

    remove: (path, ctx) =>
      inner.remove(toRemote(path), ctx),

    patch: (path, ops, ctx) =>
      inner.patch(toRemote(path), ops, ctx),
  };
}
