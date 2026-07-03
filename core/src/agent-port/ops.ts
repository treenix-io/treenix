// Agent-port pairing operations — transport-agnostic.

import { OpError } from '#errors';
import { AGENT_SESSION_TTL, hashAgentKey, timingSafeCompare } from '#security/agent';
import { createSession } from '#security/sessions';
import { checkRate } from '#security/rate-limit';
import type { Tree } from '#tree';

// Initialize an agent port pairing — operator-side, AUTHED. Sets pendingKey on an idle port.
// Splits the original idle→pending self-claim out of the unauth `agentConnect` so an unauthenticated
// remote attacker cannot plant their own key on a port and have an admin later approve it.
// The caller's tree is the auth-wrapped tree → W on the port path is enforced by withAcl.set.
export async function agentInitPair(authedTree: Tree, path: string, key: string) {
  const node = await authedTree.get(path);
  if (!node) throw new OpError('NOT_FOUND', 'Agent port not found');
  if (node.$type !== 't.agent.port') throw new OpError('BAD_REQUEST', 'Not an agent port');
  const status = (node as Record<string, unknown>).status as string ?? 'idle';
  if (status !== 'idle') throw new OpError('CONFLICT', `Port already in status: ${status}`);
  const keyHash = hashAgentKey(key);
  // withAcl.set on authedTree enforces W permission on the port path.
  await authedTree.set({ ...node, status: 'pending', pendingKey: keyHash });
  return { status: 'pending' as const };
}

export async function agentConnect(store: Tree, path: string, key: string, clientIp: string | null = null) {
  if (clientIp) checkRate(`agent:ip:${clientIp}`, 20);
  checkRate(`agent:path:${path}`, 10);
  const node = await store.get(path);
  if (!node) throw new OpError('NOT_FOUND', 'Agent port not found');
  if (node.$type !== 't.agent.port') throw new OpError('BAD_REQUEST', 'Not an agent port');

  const keyHash = hashAgentKey(key);
  const status = (node as Record<string, unknown>).status as string ?? 'idle';

  if (status === 'revoked') throw new OpError('FORBIDDEN', 'Agent access revoked');

  // R4-AUTH-1: idle → pending self-claim removed. Operator must call agentInitPair (authed)
  // first; agentConnect only validates against an existing pendingKey/approvedKey.
  if (status === 'idle')
    throw new OpError('BAD_REQUEST', 'Port not initialized — operator must call agentInitPair first');

  if (status === 'pending') {
    if (!timingSafeCompare(keyHash, (node as Record<string, unknown>).pendingKey as string))
      throw new OpError('FORBIDDEN', 'Key mismatch');
    return { status: 'pending' as const };
  }

  if (status === 'approved') {
    if (!timingSafeCompare(keyHash, (node as Record<string, unknown>).approvedKey as string))
      throw new OpError('FORBIDDEN', 'Key mismatch');

    const agentUserId = `agent:${path}`;
    const token = await createSession(store, agentUserId, { ttlMs: AGENT_SESSION_TTL });
    await store.set({ ...node, connected: true, connectedAt: Date.now() });
    return { status: 'approved' as const, token, userId: agentUserId };
  }

  throw new OpError('BAD_REQUEST', `Unknown agent status: ${status}`);
}
