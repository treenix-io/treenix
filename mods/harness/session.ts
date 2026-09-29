// Session → execute bridge. Generic — does not branch on userId pattern.
// Called by tRPC/MCP entry points so workload sessions naturally pick up
// capability-narrowed execution without those layers knowing about workloads.

import { getComponentByName } from '@treenx/core';
// buildActor moved to core (core-anz4.14) — the wire lane needs the same
// session→actor mapping and core cannot import mods.
import { buildActor, executeAction } from '@treenx/core/server/actions';
import type { Session } from '@treenx/core/security';
import { KernelError } from '@treenx/core/errors';
import type { Tree } from '@treenx/core/tree';
import { type AgentScope, type Capability, executeWithCapability } from './capability';

type ExecuteInput = { path: string; action: string; type?: string; key?: string; data?: unknown; opId?: string };

async function resolveScope(tree: Tree, session: Session): Promise<Capability | null> {
  const ref = session.scopeRef;
  if (typeof ref !== 'string' || !ref) return null;
  const key = typeof session.scopeKey === 'string' ? session.scopeKey : 'scope';
  const mode = session.scopeMode === 'work' ? 'work' : 'plan';
  const node = await tree.get(ref);
  if (!node) throw new KernelError('FORBIDDEN', `session scopeRef invalid: ${ref}`);
  const scopeRaw = getComponentByName(node, key);
  if (!scopeRaw) {
    throw new KernelError('FORBIDDEN', `session scope not found at ${ref}.${key}`);
  }
  const scope = scopeRaw as Partial<AgentScope>;
  const cap = scope[mode];
  if (!cap) throw new KernelError('FORBIDDEN', `session scope mode "${mode}" not configured`);
  return cap;
}

/** Execute on behalf of a session. Workload sessions (with `scopeRef`) get
 *  capability-narrowed execution; everything else gets plain executeAction with
 *  actor built from session metadata. */
export async function executeForSession<T = unknown>(
  tree: Tree,
  session: Session,
  input: ExecuteInput,
): Promise<T> {
  // Wire opId threads through like on the tRPC lane (core-anz4.13): it becomes
  // actor.requestId and keys the per-user idempotent-replay cache — without it
  // a workload retry double-applies and audit events lack the request id.
  const actor = buildActor(session, input.action, input.opId);
  const cap = await resolveScope(tree, session);
  if (!cap) {
    return executeAction<T>(tree, input.path, input.type, input.key, input.action, input.data,
      { actor, userId: session.userId, opId: input.opId });
  }
  return executeWithCapability<T>(tree, cap, input, actor);
}
