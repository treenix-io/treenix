// Capability — fine-grained scope for workload identities.
// Composes over withAcl(tree, ...) by intersecting allowed paths.
// Action-level enforcement (allowedExec) lives in executeWithCapability —
// Tree methods don't know about actions, so action checks happen one layer up.

import { matchesAny } from '@treenx/core/glob';
import { OpError } from '@treenx/core/errors';
import type { NodeData } from '@treenx/core';
import type { Tree, Page, PatchOp } from '@treenx/core/tree';
import { executeAction, type ActorContext } from '@treenx/core/server/actions';

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

/** Named-component placed on an agent-port node — declares per-mode capability.
 *  `plan` is the read-only-ish baseline used until the human approves the plan;
 *  `work` is the broader capability granted after approvePlan. */
export type AgentScope = {
  $type: 'agent.scope';
  plan: Capability;
  work: Capability;
};

type ScopeSpec = { read: string[]; write: string[]; exec: string[] };

/** Mod-author DX: declare scope using short read/write/exec keys.
 *  Returned object is the named-component value to attach on an agent-port node:
 *      { $path: '/agents/refund-bot', $type: 't.agent.port',
 *        scope: defineAgentScope({ plan: {...}, work: {...} }) } */
export function defineAgentScope(spec: { plan: ScopeSpec; work: ScopeSpec }): AgentScope {
  const toCap = (s: ScopeSpec): Capability => ({
    readPaths: s.read,
    writePaths: s.write,
    allowedExec: s.exec,
  });
  return { $type: 'agent.scope', plan: toCap(spec.plan), work: toCap(spec.work) };
}

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

/** Action invocation under a capability — for workload identities only.
 *  Three checks before delegating to executeAction:
 *    1. action ∈ cap.allowedExec
 *    2. target path ∈ cap.writePaths (mutating actions land somewhere)
 *    3. ctx.tree handed to action handler is wrapped → confused-deputy guard:
 *       even an allowed action cannot write outside writePaths internally.
 *  Use this from MCP/tRPC entry instead of raw executeAction for any non-admin caller. */
export async function executeWithCapability<T = unknown>(
  tree: Tree,
  cap: Capability,
  input: { path: string; action: string; type?: string; key?: string; data?: unknown },
  actor: ActorContext,
): Promise<T> {
  if (!matchesAny(cap.allowedExec, input.action)) {
    throw new OpError('FORBIDDEN', `Capability: action "${input.action}" not allowed`);
  }
  if (!matchesAny(cap.writePaths, input.path)) {
    throw new OpError('FORBIDDEN', `Capability: write not allowed on ${input.path}`);
  }
  // Wrap tree so internal ctx.tree.set/remove/patch inside the action handler
  // pass through capability filtering — closes confused-deputy hole where a
  // whitelisted action could write outside its declared scope.
  const wrapped = withCapability(tree, cap);
  return executeAction<T>(wrapped, input.path, input.type, input.key, input.action, input.data, { actor });
}
