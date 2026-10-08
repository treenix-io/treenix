// ── Sessions (tree-backed, /auth/sessions/{token}) ──
// Token hashing, session nodes, resolve/issue dispatcher, password hashing.

import { A, type NodeData, R, S, W } from '#core';
import type { Tree } from '#tree';
import { randomBytes } from 'node:crypto';
import { credentialPath as sessionPath } from '#kernel/auth/crypto';
import { ANON_PREFIX, createAnonSession, getAnonKey, verifyAnon } from './anon';
import { assertNotSystem, SYSTEM_CLAIM } from './claims';
import { SESSION_COOKIE_MAX_AGE } from './cookies';

export { hashPassword, verifyPassword, DUMMY_HASH } from '#kernel/auth/crypto';

export const SESSION_TTL_MS = SESSION_COOKIE_MAX_AGE * 1000;

// R4-AUTH-5: hash session token before persisting. The plaintext bearer never lands
// in the store path or on disk — a DB dump / FS snapshot / accidental backup of
// `/auth/sessions/*` reveals only hashes, not impersonable tokens. Mirrors the
// `hashAgentKey` pattern already used for agent keys.
/** Storage path for a session token. Exported for tests / admin tooling that need to look up
 *  a session by its plaintext token (the path itself stores only the hash). */
export { sessionPath };

// ── Types ──

// Session is open-ended: mods may patch session-node with their own metadata
// (e.g. taskPath, runPath for workload sessions). resolveToken returns all
// non-$ fields verbatim so consumers see what was written.
//
// Anon sessions carry `anonymous: true` so middleware can split withSession
// (anon OK) from authed (login-required). Detected by userId prefix `anon:`.
export type AuthedSession = { userId: string; claims?: string[]; anonymous?: false; [key: string]: unknown };
export type AnonSession = { userId: string; claims: ['public']; anonymous: true; [key: string]: unknown };
export type Session = AuthedSession | AnonSession;

// Session nodes are stored as regular nodes with extra fields
type SessionNode = NodeData & { userId: string; createdAt: number; expiresAt: number; claims?: string[] };

function isSessionNode(n: NodeData): n is SessionNode {
  return typeof (n as { userId?: unknown }).userId === 'string'
    && typeof (n as { expiresAt?: unknown }).expiresAt === 'number';
}

export async function createSession(
  tree: Tree,
  userId: string,
  opts?: { ttlMs?: number; claims?: string[] },
): Promise<string> {
  assertNotSystem(userId, opts?.claims);
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const sessionNode: SessionNode = {
    $path: sessionPath(token), $type: 'session',
    $acl: [{ g: 'admins', p: R | W | A | S }],
    userId, createdAt: now, expiresAt: now + (opts?.ttlMs ?? SESSION_TTL_MS),
    ...(opts?.claims && { claims: opts.claims }),
  };
  await tree.set(sessionNode);
  return token;
}

export async function resolveToken(tree: Tree, token: string): Promise<Session | null> {
  // Signed anon tokens: `anon.<base64url-payload>.<base64url-sig>`. Stateless — verify only.
  if (token.startsWith(ANON_PREFIX)) {
    const key = await getAnonKey(tree);
    const v = verifyAnon(token, key);
    if (!v) return null;
    return { userId: `anon:${v.id}`, claims: ['public'], anonymous: true };
  }
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  if (process.env.NODE_ENV === 'development' && token === process.env.VITE_DEV_TOKEN) {
    // 'admins' included: the dev fast-path IS the local developer — without it
    // $acl is stripped from every read and the ACL editor is unusable in dev.
    return { userId: 'dev', claims: ['u:dev', 'authenticated', 'agents', 'admins'] };
  }
  const node = await tree.get(sessionPath(token));
  if (!node) return null;
  if (!isSessionNode(node)) {
    console.error(`[auth] corrupt session: ${token.slice(0, 8)}... (shape check failed)`);
    await tree.remove(sessionPath(token));
    return null;
  }
  if (Date.now() > node.expiresAt) {
    await tree.remove(sessionPath(token));
    return null;
  }
  // Defence-in-depth: a session node bearing the system identity is treated as
  // forged. createSession blocks issuance, so the only path here is a malicious
  // direct write through a future ACL hole. Drop the node and refuse the token.
  const sessionClaims = Array.isArray(node.claims) ? node.claims as string[] : undefined;
  if (node.userId === SYSTEM_CLAIM || sessionClaims?.includes(SYSTEM_CLAIM)) {
    console.error(`[auth] forged system session removed: ${token.slice(0, 8)}...`);
    await tree.remove(sessionPath(token));
    return null;
  }
  // A session is only as alive as its account: a deleted, blocked or pending
  // user (or a revoked agent) must lose access at once, not at token expiry.
  // Absent status = legacy agent user nodes, created without one.
  const user = await tree.get(`/auth/users/${node.userId}`);
  if (!user || (user.status !== undefined && user.status !== 'active')) return null;

  // Mods write custom session metadata (taskPath, runPath, ...) as plain
  // fields; consumers read them via `session.<field>`.
  const session: Session = { userId: node.userId };
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$') || k === 'userId') continue;
    session[k] = v;
  }
  return session;
}

export async function revokeSession(tree: Tree, token: string): Promise<boolean> {
  const { changes } = await tree.remove(sessionPath(token));
  return changes === null || changes.length > 0;
}

/** Outer auth dispatcher. Distinguishes absent / bad-bearer / expired-session / ok.
 *  Owner's strict rule (closes core-t9d): ANY invalid cookie → expired_session.
 *  Never silently downgrades user-session to anon. */
export async function resolveOrIssueSession(
  tree: Tree,
  cookieToken: string | null,
  bearerToken: string | null,
): Promise<
  | { kind: 'ok'; session: Session; token: string; issued: boolean }
  | { kind: 'bad_bearer' }
  | { kind: 'expired_session' }
> {
  if (bearerToken) {
    const s = await resolveToken(tree, bearerToken);
    if (!s) return { kind: 'bad_bearer' };
    return { kind: 'ok', session: s, token: bearerToken, issued: false };
  }
  if (cookieToken) {
    const s = await resolveToken(tree, cookieToken);
    if (s) return { kind: 'ok', session: s, token: cookieToken, issued: false };
    return { kind: 'expired_session' };
  }
  const anon = await createAnonSession(tree);
  return { kind: 'ok', session: anon.session, token: anon.token, issued: true };
}
