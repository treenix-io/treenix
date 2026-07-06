// Path-rewriting Tree combinator — mounts a remote tree at a local prefix.
// Like Linux mount: remote /strategies/x ↔ local /app/live/strategies/x
//
// localBase:  where the tree is mounted in our namespace (e.g. '/app/live')
// remoteBase: root of the remote tree to use (e.g. '/', or '/data' for a subtree)

import type { NodeData } from '#core';
import { assertSafePath } from '#core/path';
import type { ExecOpts, Page, PatchManyEntry, Tree } from './index';

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
    // R4-TREE-1: do NOT silently drop malformed nodes — inner tree is trusted code; a node
    // with no $path is a bug, not user data. remapNode already throws when $path is missing.
    return { ...page, items: page.items.map(remapNode) };
  }

  function isNodeShaped(v: unknown): v is NodeData {
    return !!v && typeof v === 'object' && typeof (v as { $path?: unknown }).$path === 'string';
  }

  // Execute results come from a remote action — unlike get/getChildren, the
  // returned $path is NOT guaranteed to sit under remoteBase. A naive toLocal
  // on an out-of-base path would corrupt it; fail loudly instead.
  function toLocalStrict(remotePath: string): string {
    if (rb && remotePath !== rb && !remotePath.startsWith(rb + '/'))
      throw new Error(`repath: execute result $path ${remotePath} outside remoteBase ${rb || '/'}`);
    return toLocal(remotePath);
  }

  // Remap top-level node-shaped and Page-shaped action results back to the
  // local namespace. Arbitrary nested paths inside result payloads are
  // intentionally untranslated — only node/Page shapes carry authority paths.
  function remapExecResult(result: unknown): unknown {
    if (isNodeShaped(result)) return { ...result, $path: toLocalStrict(result.$path) };
    if (result && typeof result === 'object' && Array.isArray((result as { items?: unknown }).items)) {
      const page = result as { items: unknown[] };
      if (page.items.every(isNodeShaped)) {
        return { ...page, items: page.items.map((n) => ({ ...n, $path: toLocalStrict(n.$path) })) };
      }
    }
    return result;
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

    // scanChildren — remap each yielded node's $path back to local namespace.
    // Cursor is opaque (inner uses inner $path); we pass it through unchanged
    // so a follow-up call with `after` resumes correctly on the inner side.
    // Only exposed when inner supports scanChildren — wire-facing trees
    // (RPC transport) deliberately don't.
    ...(inner.scanChildren ? {
      async *scanChildren(path: string, opts?: Parameters<NonNullable<Tree['scanChildren']>>[1], ctx?: unknown) {
        for await (const entry of inner.scanChildren!(toRemote(path), opts, ctx)) {
          yield { node: remapNode(entry.node), cursor: entry.cursor };
        }
      },
    } : {}),

    // execute — forwarded only when inner has the capability (same idiom as
    // scanChildren). Presence marks foreign authority: the remote side
    // resolves the handler and enforces permissions under ITS principal.
    // Prerequisite for federation mounts (t.mount.tree.trpc, core-nin.7).
    ...(inner.execute ? {
      execute: async (path: string, action: string, data?: unknown, opts?: ExecOpts, ctx?: unknown) =>
        remapExecResult(await inner.execute!(toRemote(path), action, data, opts, ctx)),
    } : {}),

    set: (node, ctx) =>
      inner.set({ ...node, $path: toRemote(node.$path) }, ctx),

    remove: (path, ctx) =>
      inner.remove(toRemote(path), ctx),

    patch: (path, ops, ctx) =>
      inner.patch(toRemote(path), ops, ctx),

    // patchMany — forwarded only when inner has the capability (same idiom as
    // scanChildren/execute); ancestor AND every member path translate.
    ...(inner.patchMany ? {
      patchMany: (ancestor: string, entries: PatchManyEntry[], ctx?: unknown) =>
        inner.patchMany!(
          toRemote(ancestor),
          entries.map(e => ({ path: toRemote(e.path), ops: e.ops })),
          ctx,
        ),
    } : {}),
  };
}
