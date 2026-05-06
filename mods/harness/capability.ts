// Capability — fine-grained scope for workload identities.
// Composes over withAcl(tree, ...) by intersecting allowed paths.
// Action-level enforcement (allowedExec) lives in executeWithCapability —
// Tree methods don't know about actions, so action checks happen one layer up.

import { matchesAny } from '@treenx/core/glob';
import { OpError } from '@treenx/core/errors';
import type { NodeData } from '@treenx/core';
import type { Tree, Page, PatchOp } from '@treenx/core/tree';

/** Capability bundle declared by mod author via defineAgentScope.
 *  Glob patterns: '/foo/*' single-level, '/foo/**' deep, exact '/foo' literal. */
export type Capability = {
  /** Paths the workload may read. Empty list = deny all. */
  readPaths: string[];
  /** Paths the workload may write/remove/patch. Empty list = deny all. */
  writePaths: string[];
  /** Action names the workload may invoke (checked by executeWithCapability). */
  allowedExec: string[];
};

function denyOutOfScope(op: 'read' | 'write', path: string): never {
  throw new OpError('FORBIDDEN', `Capability: ${op} not allowed on ${path}`);
}

/** Wrap a Tree so all reads/writes are intersected with capability paths.
 *  Caller should pass an already-ACL-wrapped tree (withAcl(...)) so this layer
 *  applies on top. ACL still rules what's possible at all; capability narrows.
 *  Fail-closed: empty readPaths/writePaths denies that operation entirely. */
export function withCapability(tree: Tree, cap: Capability): Tree {
  const canRead = (path: string) => matchesAny(cap.readPaths, path);
  const canWrite = (path: string) => matchesAny(cap.writePaths, path);

  return {
    async get(path, ctx) {
      if (!canRead(path)) denyOutOfScope('read', path);
      return tree.get(path, ctx);
    },

    async getChildren(path, opts, ctx): Promise<Page<NodeData>> {
      if (!canRead(path)) denyOutOfScope('read', path);
      const result = await tree.getChildren(path, opts, ctx);
      // Filter children by readPaths so peeking at a parent doesn't leak siblings
      const items = result.items.filter((n: NodeData) => canRead(n.$path));
      return { ...result, items, total: items.length };
    },

    async set(node, ctx) {
      if (!canWrite(node.$path)) denyOutOfScope('write', node.$path);
      return tree.set(node, ctx);
    },

    async remove(path, ctx) {
      if (!canWrite(path)) denyOutOfScope('write', path);
      return tree.remove(path, ctx);
    },

    async patch(path, ops: PatchOp[], ctx) {
      if (!canWrite(path)) denyOutOfScope('write', path);
      return tree.patch(path, ops, ctx);
    },
  };
}
