// Path-rewriting Tree combinator — mounts a remote tree at a local prefix.
// Like Linux mount: remote /strategies/x ↔ local /app/live/strategies/x
//
// localBase:  where the tree is mounted in our namespace (e.g. '/app/live')
// remoteBase: root of the remote tree to use (e.g. '/', or '/data' for a subtree)

import type { NodeData } from '#core';
import { assertSafePath } from '#core/path';
import type { Page, Tree } from './index';

export function createRepathTree(inner: Tree, localBase: string, remoteBase: string = '/'): Tree {
  // Normalize: strip trailing slashes, handle root
  const lb = localBase === '/' ? '' : localBase;
  const rb = remoteBase === '/' ? '' : remoteBase;

  // R4-TREE-1: enforce that callers actually address the mount. Without this:
  //   1. `localPath.slice(lb.length)` returns garbage when localPath is shorter than lb;
  //   2. `..` segments propagate to the inner tree (defense-in-depth on top of the inner's own
  //      `assertSafePath`, e.g. mimefs.ts catches FS-level traversal but the LOGICAL path still
  //      pollutes cache/sub state with `..`);
  //   3. precedence on `rb + rest || '/'` is `(rb + rest) || '/'` — when rest is '' (path equals
  //      localBase exactly), result is `rb` directly, so `get(localBase)` reads the remote root.
  //      That last case is intentional ("read the mount root"), but lint paths first.
  function assertInBase(localPath: string): void {
    assertSafePath(localPath);
    if (lb && localPath !== lb && !localPath.startsWith(lb + '/'))
      throw new Error(`repath: path ${localPath} not under localBase ${lb || '/'}`);
  }

  function toRemote(localPath: string): string {
    assertInBase(localPath);
    const rest = localPath.slice(lb.length);
    return rb + rest || '/';
  }

  function toLocal(remotePath: string): string {
    const rest = remotePath.slice(rb.length);
    return lb + rest || '/';
  }

  function remapNode(node: NodeData): NodeData {
    if (!node.$path) throw new Error(`repath: node missing $path (type=${node.$type})`);
    return { ...node, $path: toLocal(node.$path) };
  }

  function remapPage(page: Page<NodeData>): Page<NodeData> {
    return { ...page, items: page.items.filter(n => n.$path).map(remapNode) };
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
