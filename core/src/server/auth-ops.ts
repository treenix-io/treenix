// Auth operations — transport-agnostic.
// Throws OpError, never TRPCError. Transport layer maps errors.

import { createNode, isComponent, R, W } from '#core';
import type { Tree } from '#tree';
import { randomBytes } from 'node:crypto';
import { AGENT_SESSION_TTL, hashAgentKey, timingSafeCompare } from './agent';
import { createSession, DUMMY_HASH, hashPassword, revokeSession, verifyPassword } from './auth';
import { OpError } from '#errors';
import { checkRate } from './rate-limit';

function assertUserId(userId: string): void {
  if (/[/\\\0]/.test(userId)) throw new OpError('BAD_REQUEST', 'Invalid userId');
}

export async function registerUser(store: Tree, userId: string, password: string) {
  checkRate(`register:${userId}`);
  assertUserId(userId);

  const userPath = `/auth/users/${userId}`;
  const existing = await store.get(userPath);
  if (existing) throw new OpError('CONFLICT', 'User already exists');

  const { items } = await store.getChildren('/auth/users', { limit: 1 });
  const isFirstUser = items.length === 0;

  const hash = await hashPassword(password);
  const node = createNode(userPath, 'user', {
    status: isFirstUser ? 'active' : 'pending',
  }, {
    credentials: { $type: 'credentials', hash },
    groups: { $type: 'groups', list: isFirstUser ? ['admins'] : [] },
  });
  node.$owner = userId;
  node.$acl = [
    { g: 'owner', p: R | W },
    { g: 'authenticated', p: 0 },
  ];

  await store.set(node);

  if (!isFirstUser) return { token: null, userId, pending: true };
  const token = await createSession(store, userId);
  return { token, userId, pending: false };
}

export async function loginUser(store: Tree, userId: string, password: string) {
  checkRate(`login:${userId}`);
  assertUserId(userId);

  const userPath = `/auth/users/${userId}`;
  const user = await store.get(userPath);
  const cv = user ? user['credentials'] : undefined;
  const creds = isComponent(cv) ? cv : undefined;
  const hash = typeof creds?.['hash'] === 'string' ? creds['hash'] : undefined;
  // Always run scrypt to prevent timing-based user enumeration
  const ok = await verifyPassword(password, hash ?? DUMMY_HASH);
  if (!user || !hash || !ok) throw new OpError('UNAUTHORIZED', 'Invalid credentials');
  if (user.status !== 'active') throw new OpError('FORBIDDEN', 'Account not activated');

  const token = await createSession(store, userId);
  return { token, userId };
}

export async function logoutUser(store: Tree, token: string) {
  await revokeSession(store, token);
  return { ok: true };
}

export async function devLogin(store: Tree) {
  // Require BOTH signals — single env-var typo in prod must not grant admin.
  // Boot-time assertion in main.ts also crashes if VITE_DEV_LOGIN is set in non-dev.
  if (process.env.NODE_ENV !== 'development' || !process.env.VITE_DEV_LOGIN) {
    throw new OpError('FORBIDDEN', 'Dev-only');
  }
  const userId = 'dev';
  const userPath = `/auth/users/${userId}`;
  if (!await store.get(userPath)) {
    const node = createNode(userPath, 'user', {}, {
      groups: { $type: 'groups', list: ['admins'] },
    });
    node.$owner = userId;
    await store.set(node);
  }
  const token = await createSession(store, userId);
  return { token, userId };
}

export async function agentConnect(store: Tree, path: string, key: string) {
  checkRate(`agent:${path}`);
  const node = await store.get(path);
  if (!node) throw new OpError('NOT_FOUND', 'Agent port not found');
  if (node.$type !== 't.agent.port') throw new OpError('BAD_REQUEST', 'Not an agent port');

  const keyHash = hashAgentKey(key);
  const status = (node as Record<string, unknown>).status as string ?? 'idle';

  if (status === 'revoked') throw new OpError('FORBIDDEN', 'Agent access revoked');

  if (status === 'idle') {
    await store.set({ ...node, status: 'pending', pendingKey: keyHash });
    return { status: 'pending' as const };
  }

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
