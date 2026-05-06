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

// In-process serialize chain — closes the first-user admin-election TOCTOU window.
// Two concurrent registers on a fresh store would both observe items.length === 0 and both gain admin.
// Single-process tenant model: in-memory chain is enough; multi-process needs a tree-level lock or seed-time bootstrap.
let registerChain: Promise<unknown> = Promise.resolve();
function serializeRegister<T>(fn: () => Promise<T>): Promise<T> {
  const next = registerChain.then(fn, fn);
  registerChain = next.catch(() => {});
  return next;
}

export function registerUser(store: Tree, userId: string, password: string, clientIp: string | null = null) {
  return serializeRegister(async () => {
    // IP bucket caps total registrations from one origin even when attacker rotates userId.
    if (clientIp) checkRate(`register:ip:${clientIp}`, 5);
    checkRate(`register:user:${userId}`, 3);
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
  });
}

export async function loginUser(store: Tree, userId: string, password: string, clientIp: string | null = null) {
  if (clientIp) checkRate(`login:ip:${clientIp}`, 10);
  checkRate(`login:user:${userId}`, 5);
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

export async function agentConnect(store: Tree, path: string, key: string, clientIp: string | null = null) {
  if (clientIp) checkRate(`agent:ip:${clientIp}`, 20);
  checkRate(`agent:path:${path}`, 10);
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
