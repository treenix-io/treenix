// Auth operations — transport-agnostic.
// Throws KernelError, never TRPCError. Transport layer maps errors.

import { getComponentByName, makeNode, R, W } from '#core';
import type { Tree } from '#tree';
import { assertNotSystem } from './claims';
import { createSession, DUMMY_HASH, hashPassword, revokeSession, verifyPassword } from './sessions';
import { KernelError } from '#errors';
import { checkRate } from './rate-limit';

// userId becomes a path segment under /auth/users/. Original check (slash/backslash/NUL) missed
// `..` and dot-only names → on FS-backed stores `path.join` normalizes them and writes outside
// /auth/users/. Tighten to allowlist + length cap; reject dot-only names.
// Allowlist includes `@` and `+` for email-format userIds (foo+tag@bar.com); neither is a path
// separator nor enables traversal.
function assertUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 64
      || !/^[A-Za-z0-9._@+-]+$/.test(userId)
      || /^\.+$/.test(userId))
    throw new KernelError('INVALID', 'Invalid userId');
  assertNotSystem(userId);
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
    if (existing) throw new KernelError('CONFLICT', 'User already exists');

    const { items } = await store.getChildren('/auth/users', { limit: 1 });
    const isFirstUser = items.length === 0;

    const hash = await hashPassword(password);
    const node = makeNode(userPath, 'user', {
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
  const creds = user ? getComponentByName(user, 'credentials') : undefined;
  const hash = typeof creds?.['hash'] === 'string' ? creds['hash'] : undefined;
  // Always run scrypt to prevent timing-based user enumeration
  const ok = await verifyPassword(password, hash ?? DUMMY_HASH);
  // R4-AUTH-6: collapse pending-status differential into UNAUTHENTICATED. Distinct FORBIDDEN
  // for pending users let credential-stuffing oracles confirm a valid (userId, password) pair
  // before the account was even activated. Same response shape as wrong-credentials.
  if (!user || !hash || !ok || user.status !== 'active')
    throw new KernelError('UNAUTHENTICATED', 'Invalid credentials');

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
    throw new KernelError('FORBIDDEN', 'Dev-only');
  }
  const userId = 'dev';
  const userPath = `/auth/users/${userId}`;
  if (!await store.get(userPath)) {
    const node = makeNode(userPath, 'user', { status: 'active' }, {
      groups: { $type: 'groups', list: ['admins'] },
    });
    node.$owner = userId;
    await store.set(node);
  }
  const token = await createSession(store, userId);
  return { token, userId };
}

export { agentConnect, agentInitPair } from '#agent-port/ops';
