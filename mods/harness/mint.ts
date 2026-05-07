// mintWorkloadToken — provisions a per-run workload session bound to an agent-port scope.
// The created session lives at /auth/sessions/<token-hash> with admin-only ACL so the
// workload itself cannot tamper with scopeMode/scopeRef. Mode starts as 'plan';
// flipping to 'work' is a separate admin/system action invoked when AiPlan.approvePlan runs.

import { createNode, R, W, A, S } from '@treenx/core';
import { createSession, sessionPath } from '@treenx/core/server/auth';
import { OpError } from '@treenx/core/errors';
import type { Tree } from '@treenx/core/tree';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export type MintOpts = {
  agentPath: string;
  taskPath: string;
  runPath: string;
  /** Default 'plan'. Override only for admin tooling that pre-approves. */
  mode?: 'plan' | 'work';
  /** Custom TTL — defaults to 4h. */
  ttlMs?: number;
  /** Named-component key on the agent-port node holding the AgentScope. */
  scopeKey?: string;
};

export type MintResult = {
  token: string;
  sessionPath: string;
  userId: string;
};

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export async function mintWorkloadToken(tree: Tree, opts: MintOpts): Promise<MintResult> {
  const scopeKey = opts.scopeKey ?? 'scope';
  const mode = opts.mode ?? 'plan';

  const port = await tree.get(opts.agentPath);
  if (!port) throw new OpError('NOT_FOUND', `agent-port not found: ${opts.agentPath}`);
  const scope = (port as Record<string, unknown>)[scopeKey];
  if (!scope || typeof scope !== 'object') {
    throw new OpError('BAD_REQUEST', `agent-port has no ${scopeKey} component: ${opts.agentPath}`);
  }

  const runId = lastSegment(opts.runPath);
  const userId = `agent-workload:${runId}`;
  const userPath = `/auth/users/${userId}`;
  const userExists = await tree.get(userPath);
  if (!userExists) {
    await tree.set(createNode(userPath, 'user', { status: 'active' }, {
      groups: { $type: 'groups', list: ['agent-workload'] },
    }));
  }

  const token = await createSession(tree, userId, { ttlMs: opts.ttlMs ?? FOUR_HOURS_MS });
  const sPath = sessionPath(token);

  // Patch session-node with workload metadata. Single set-after-create writes
  // taskPath, runPath, scopeRef, scopeKey, scopeMode atomically into the node.
  const sessionNode = await tree.get(sPath);
  if (!sessionNode) throw new OpError('CONFLICT', 'session disappeared after createSession');
  await tree.set({
    ...sessionNode,
    taskPath: opts.taskPath,
    runPath: opts.runPath,
    scopeRef: opts.agentPath,
    scopeKey,
    scopeMode: mode,
    // Explicit admin-only ACL — fail-closed against later code that might widen sessions.
    $acl: [{ g: 'admins', p: R | W | A | S }],
  });

  return { token, sessionPath: sPath, userId };
}
