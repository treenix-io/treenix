// Session → execute bridge. Generic — does not branch on userId pattern.
// Called by tRPC/MCP entry points so workload sessions naturally pick up
// capability-narrowed execution without those layers knowing about workloads.

import type { ActorContext } from '@treenx/core/server/actions';
import { executeAction } from '@treenx/core/server/actions';
import type { Session } from '@treenx/core/server/auth';
import { OpError } from '@treenx/core/errors';
import type { Tree } from '@treenx/core/tree';
import { randomUUID } from 'node:crypto';
import { type AgentScope, type Capability, executeWithCapability } from './capability';

type ExecuteInput = { path: string; action: string; type?: string; key?: string; data?: unknown };

function buildActor(session: Session, action: string): ActorContext {
  return {
    id: session.userId,
    action,
    requestId: randomUUID(),
    taskPath: typeof session.taskPath === 'string' ? session.taskPath : undefined,
    runPath: typeof session.runPath === 'string' ? session.runPath : undefined,
  };
}

async function resolveScope(tree: Tree, session: Session): Promise<Capability | null> {
  const ref = session.scopeRef;
  if (typeof ref !== 'string' || !ref) return null;
  const key = typeof session.scopeKey === 'string' ? session.scopeKey : 'scope';
  const mode = session.scopeMode === 'work' ? 'work' : 'plan';
  const node = await tree.get(ref);
  if (!node) throw new OpError('FORBIDDEN', `session scopeRef invalid: ${ref}`);
  const scopeRaw = node[key];
  if (!scopeRaw || typeof scopeRaw !== 'object') {
    throw new OpError('FORBIDDEN', `session scope not found at ${ref}.${key}`);
  }
  const scope = scopeRaw as Partial<AgentScope>;
  const cap = scope[mode];
  if (!cap) throw new OpError('FORBIDDEN', `session scope mode "${mode}" not configured`);
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
  const actor = buildActor(session, input.action);
  const cap = await resolveScope(tree, session);
  if (!cap) {
    return executeAction<T>(tree, input.path, input.type, input.key, input.action, input.data, { actor });
  }
  return executeWithCapability<T>(tree, cap, input, actor);
}
