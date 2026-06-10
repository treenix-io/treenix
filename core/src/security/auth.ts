// Treenix Auth — ACL on nodes
// Group-based permissions, tree inheritance, deny-is-sticky.
// Tree wrapper: resolves ACL per path, strips forbidden components.

import {
  A,
  type ComponentData,
  getComponent,
  type GroupPerm,
  isComponent,
  type NodeData,
  R,
  resolve as resolveHandler,
  S,
  W,
} from '#core';
import { OpError } from '#errors';
import { asTreeSource, assertSafePatchPath, mapNodeForSift, paginate, type Page, type Tree } from '#tree';
import { createSiftTest, withAclQueryTree } from '#tree/query';
import { executeList } from '#tree/read-runtime';
import { resolveReadPlan } from '#mount/resolve-plan';
import { type Actor, assertSourceReadable, createProjector } from './projector';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// R4-AUTH-5: hash session token before persisting. The plaintext bearer never lands
// in the store path or on disk — a DB dump / FS snapshot / accidental backup of
// `/auth/sessions/*` reveals only hashes, not impersonable tokens. Mirrors the
// `hashAgentKey` pattern already used for agent keys.
function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Storage path for a session token. Exported for tests / admin tooling that need to look up
 *  a session by its plaintext token (the path itself stores only the hash). */
export function sessionPath(token: string): string {
  return `/auth/sessions/${sessionHash(token)}`;
}

// ── Cookie auth (browser) ──
// Replaces the F9 stream-token machinery with HttpOnly cookies. Browsers send
// cookies on every request including SSE EventSource — no mintStreamToken dance needed.
// SameSite=Strict closes CSRF since browser refuses cookie on cross-origin POST/GET-with-credentials.
// Bearer-in-Authorization-header continues to work in parallel for agents/MCP/tests.

export const SESSION_COOKIE = 'treenix_session';

const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
export const SESSION_TTL_MS = SESSION_COOKIE_MAX_AGE * 1000;
// Anon cookies live a year — server has no storage cost (signed stateless tokens) and
// returning-visitor identity persistence is a feature (analytics/UX).
export const ANON_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export function buildSessionCookie(token: string, maxAgeSeconds: number = SESSION_COOKIE_MAX_AGE): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Parse `${SESSION_COOKIE}=<token>` from a Cookie header. Returns null if absent. */
export function parseSessionCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === SESSION_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export type AclHandler = () => GroupPerm[];

declare module '#core/context' {
  interface ContextHandlers {
    acl: AclHandler;
  }
}

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

// ── Sessions (tree-backed, /auth/sessions/{token}) ──

/** Reserved claim/userId for bootstrap-only ACL bypass via root grant.
 *  Must NEVER appear in a user-facing session or claim list — every API that
 *  could mint a session, build claims, or accept a user-supplied id must reject it. */
export const SYSTEM_CLAIM = 'system';

export function assertNotSystem(userId: string, claims?: readonly string[]): void {
  if (userId === SYSTEM_CLAIM) throw new OpError('FORBIDDEN', 'reserved userId');
  if (claims && claims.includes(SYSTEM_CLAIM)) throw new OpError('FORBIDDEN', 'reserved claim');
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
    return { userId: 'dev', claims: ['u:dev', 'authenticated', 'agents'] };
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
  return tree.remove(sessionPath(token));
}

// ── Anonymous sessions (signed, stateless) ──
//
// Anon token format: `anon.<base64url(payload)>.<base64url(hmac-sha256(payload, key))>`
// Payload: { id, iat, exp }, id = 16-byte hex.
// userId = `anon:<id>` — publishable, safe in $owner/audit/watch keys (NOT bearer token).
// Server stores nothing — verify-only. Cross-restart/cross-node identity persistence via env-key.
//
// Closes core-t9d silent-downgrade hole: middleware no longer falls back to claims=['public']
// without identity; anon is a real signed identity issued at the HTTP layer.

const ANON_PREFIX = 'anon.';
const ANON_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year — returning-visitor identity persistence
const ANON_KEY_PATH = '/auth/secrets/anon-key';

let anonKeyCache: Buffer | null = null;
let anonKeyPromise: Promise<Buffer> | null = null; // race-serialize concurrent first-callers

/** Exported for boot validation in factory.ts and tests. */
export async function getAnonKey(tree: Tree): Promise<Buffer> {
  if (anonKeyCache) return anonKeyCache;
  if (anonKeyPromise) return anonKeyPromise;
  anonKeyPromise = (async () => {
    const envKey = process.env.TREENIX_ANON_KEY;
    if (envKey) {
      if (!/^[0-9a-f]{64}$/.test(envKey)) {
        throw new Error('TREENIX_ANON_KEY must be 64 hex chars (32 bytes)');
      }
      anonKeyCache = Buffer.from(envKey, 'hex');
      return anonKeyCache;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TREENIX_ANON_KEY required in production (no env fallback)');
    }
    // Dev fallback: persistent tree-backed key, lazy-created
    const node = await tree.get(ANON_KEY_PATH);
    if (node) {
      // Node exists — require valid key. Don't silently re-mint over corrupt field.
      const keyVal = node['key'];
      if (typeof keyVal !== 'string') {
        throw new Error(`malformed anon key at ${ANON_KEY_PATH} (key field missing or not string)`);
      }
      if (!/^[0-9a-f]{64}$/.test(keyVal)) {
        throw new Error(`malformed anon key at ${ANON_KEY_PATH} (must be 64 hex chars)`);
      }
      anonKeyCache = Buffer.from(keyVal, 'hex');
      return anonKeyCache;
    }
    const key = randomBytes(32);
    await tree.set({
      $path: ANON_KEY_PATH, $type: 'secret',
      // Explicit deny on inheritance: admins read/write, authenticated and public denied.
      // Without explicit zeros, authenticated users could inherit read from a parent
      // and mint arbitrary anons by extracting the key.
      $acl: [
        { g: 'admins', p: R | W | A | S },
        { g: 'authenticated', p: 0 },
        { g: 'public', p: 0 },
      ],
      key: key.toString('hex'),
    });
    anonKeyCache = key;
    return key;
  })().catch((e) => { anonKeyPromise = null; throw e; });
  return anonKeyPromise;
}

function signAnon(id: string, key: Buffer): string {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ id, iat: now, exp: now + ANON_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${ANON_PREFIX}${body}.${sig}`;
}

function verifyAnon(token: string, key: Buffer): { id: string; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'anon') return null;
  const [, body, sig] = parts;
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { id?: unknown; exp?: unknown };
    if (typeof p.id !== 'string' || !/^[0-9a-f]{32}$/.test(p.id)) return null;
    if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null;
    if (p.exp < Date.now()) return null;
    return { id: p.id, exp: p.exp };
  } catch { return null; }
}

export async function createAnonSession(tree: Tree): Promise<{ session: AnonSession; token: string }> {
  const key = await getAnonKey(tree);
  const id = randomBytes(16).toString('hex');
  const token = signAnon(id, key);
  return { session: { userId: `anon:${id}`, claims: ['public'], anonymous: true }, token };
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

/** Test-only: clear module-global anon key state between test cases. */
export function _resetAnonKeyForTests(): void {
  anonKeyCache = null;
  anonKeyPromise = null;
}

// ── Password hashing ──

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))),
  );
  return salt.toString('hex') + ':' + key.toString('hex');
}

// Pre-computed dummy hash for constant-time login (prevents timing-based user enumeration)
export const DUMMY_HASH = randomBytes(16).toString('hex') + ':' + randomBytes(64).toString('hex');

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [saltHex, keyHex] = hash.split(':');
  if (!saltHex || !keyHex) throw new Error('Malformed password hash');
  const salt = Buffer.from(saltHex, 'hex');
  const stored = Buffer.from(keyHex, 'hex');
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))),
  );
  return timingSafeEqual(stored, key);
}

// ── Path utils ──

export function ancestorPaths(path: string): string[] {
  if (path === '/') return ['/'];
  const parts = path.split('/').filter(Boolean);
  const result = ['/'];
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    result.push(current);
  }
  return result;
}

// ── ACL resolution ──

// Accumulated ACL state at a given tree level — built from root downward.
// Cached per level so sibling paths skip ancestor re-processing entirely.
type AclState = {
  groupPerms: Map<string, number>;
  denied: Set<string>;
  deniedBits: Map<string, number>;
  owner: string | undefined;
};

function cloneAclState(s: AclState): AclState {
  return {
    groupPerms: new Map(s.groupPerms),
    denied: new Set(s.denied),
    deniedBits: new Map(s.deniedBits),
    owner: s.owner,
  };
}

// Most-permissive group wins, but each group's allows are first masked by its
// sticky deny-bits — so a deny is order-independent (a descendant/later deny
// revokes an earlier/ancestor allow).
function maxAllowedPerm(groupPerms: Map<string, number>, deniedBits: Map<string, number>): number {
  let best = 0;
  for (const [g, v] of groupPerms) {
    const masked = v & ~(deniedBits.get(g) || 0);
    if (masked > best) best = masked;
  }
  return best;
}

// Walk ancestors, carry forward per-group.
// p=0: deny all (sticky), p<0: deny bits (sticky), p>0: allow bits.
// "owner" pseudo-group: matches if userId === $owner on node (or inherited).
//
// nodeCache: avoids re-fetching already-seen nodes (keyed by path, null = not found)
// stateCache: accumulated ACL state at each tree level — on sibling paths, start
//   from the deepest cached ancestor instead of walking from root again.
export async function resolvePermission(
  tree: Tree,
  path: string,
  userId: string | null,
  claims: string[],
  cache?: Map<string, number>,
  nodeCache?: Map<string, NodeData | null>,
  stateCache?: Map<string, AclState>,
): Promise<number> {
  if (cache?.has(path)) return cache.get(path)!;

  const ancestors = ancestorPaths(path);

  // Start from deepest cached ancestor state (skip already-accumulated prefix)
  let startIdx = 0;
  let state: AclState = { groupPerms: new Map(), denied: new Set(), deniedBits: new Map(), owner: undefined };

  if (stateCache) {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const cached = stateCache.get(ancestors[i]);
      if (cached) {
        state = cloneAclState(cached);
        startIdx = i + 1;
        break;
      }
    }
  }

  for (let i = startIdx; i < ancestors.length; i++) {
    const p = ancestors[i];

    let node: NodeData | null | undefined;
    if (nodeCache?.has(p)) {
      node = nodeCache.get(p);
    } else {
      const fetched = await tree.get(p);
      node = fetched ?? null;
      nodeCache?.set(p, node);
    }

    if (node) {
      if (node.$owner) state.owner = node.$owner;
      if (node.$acl) {
        for (const { g, p: perm } of node.$acl) {
          const matches = g === 'owner' ? userId !== null && userId === state.owner : claims.includes(g);
          if (!matches) continue;
          if (state.denied.has(g)) continue;
          if (perm < 0) {
            // Sticky deny specific bits
            const bits = -perm;
            state.deniedBits.set(g, (state.deniedBits.get(g) || 0) | bits);
          } else if (perm === 0) {
            // Deny all (sticky)
            state.denied.add(g);
            state.groupPerms.set(g, 0);
          } else {
            // Allow bits, mask out denied
            const allowed = perm & ~(state.deniedBits.get(g) || 0);
            state.groupPerms.set(g, allowed);
          }
        }
      }
    }

    // Cache accumulated state at this level — future sibling paths start here
    stateCache?.set(p, cloneAclState(state));
  }

  const effective = maxAllowedPerm(state.groupPerms, state.deniedBits);
  cache?.set(path, effective);
  return effective;
}

// ── Component ACL ──

export function componentPerm(
  comp: ComponentData,
  userId: string | null,
  claims: string[],
  owner: string | undefined,
): number {
  const typeAcl = resolveHandler(comp.$type, 'acl');
  const acls: GroupPerm[][] = [];
  if (typeAcl) acls.push(typeAcl());
  if (comp.$acl) acls.push(comp.$acl);
  if (acls.length === 0) return R | W | A; // no ACL = full access

  let effective = R | W | A;
  for (const aclList of acls) {
    const groupPerms = new Map<string, number>();
    const deniedBits = new Map<string, number>();
    for (const { g, p } of aclList) {
      const matches = g === 'owner' ? userId !== null && userId === owner : claims.includes(g);
      if (!matches) continue;
      if (p < 0) {
        // Sticky deny specific bits
        const bits = -p;
        deniedBits.set(g, (deniedBits.get(g) || 0) | bits);
      } else if (p === 0) {
        groupPerms.set(g, 0);
      } else {
        // Allow bits, mask out denied
        const allowed = p & ~(deniedBits.get(g) || 0);
        groupPerms.set(g, allowed);
      }
    }
    effective &= maxAllowedPerm(groupPerms, deniedBits);
  }
  return effective;
}

export function stripComponents(node: NodeData, userId: string | null, claims: string[]): NodeData {
  const out: NodeData = { $path: node.$path, $type: node.$type };
  if (node.$acl) out.$acl = node.$acl;
  if (node.$owner) out.$owner = node.$owner;
  if (node.$rev !== undefined) out.$rev = node.$rev;
  if ('$ref' in node) out['$ref'] = node['$ref'];
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    if (!isComponent(val)) { out[key] = val; continue; }
    if (componentPerm(val, userId, claims, node.$owner) & R) out[key] = val;
  }
  return out;
}

// ── Build claims ──

export async function buildClaims(tree: Tree, userId: string): Promise<string[]> {
  assertNotSystem(userId);
  const group = userId.startsWith('anon:') ? 'public' : 'authenticated';
  const claims = [`u:${userId}`, group];
  const userNode = await tree.get(`/auth/users/${userId}`);
  if (userNode) {
    // Strict: component MUST be at key 'groups' with $type='groups'. A poisoned key with
    // alternate $type would otherwise leak admin-claim via group list. Privilege escalation gate.
    const groups = getComponent<{ list: string[] }>(userNode, 'groups', 'groups');
    if (Array.isArray(groups?.list)) {
      // Drop SYSTEM_CLAIM if it somehow lands in a user's groups list — last line
      // of defence; the seed/admin tooling that writes /auth/users/*/groups must
      // refuse to write 'system' there in the first place.
      for (const g of groups.list) if (g !== SYSTEM_CLAIM) claims.push(g);
    }
  }
  return claims;
}

// ── Patch op rules ──
// Mirrors stripComponents visibility (lines 268-279, 320-324, 340-344):
//   $path/$type/$rev/$ref always visible → t allowed; only $ref mutable.
//   $acl/$owner visible only with A → both gates require A.
//   $refs always stripped → both ops forbidden (oracle).
//   other $-fields → forbidden (unknown system fields).
function assertMutationSystemField(firstSeg: string, isAdmin: boolean): void {
  if (!firstSeg.startsWith('$')) return;
  if (firstSeg === '$ref') return;
  if (firstSeg === '$acl' || firstSeg === '$owner') {
    if (isAdmin) return;
    throw new OpError('FORBIDDEN', `Access denied: ${firstSeg} requires A permission`);
  }
  throw new OpError('FORBIDDEN', `Access denied: ${firstSeg} is system-managed`);
}

function assertTestSystemField(firstSeg: string, isAdmin: boolean): void {
  if (!firstSeg.startsWith('$')) return;
  if (firstSeg === '$path' || firstSeg === '$type' || firstSeg === '$rev' || firstSeg === '$ref') return;
  if (firstSeg === '$acl' || firstSeg === '$owner') {
    if (isAdmin) return;
    throw new OpError('FORBIDDEN', `Access denied: ${firstSeg} requires A permission`);
  }
  throw new OpError('FORBIDDEN', `Access denied: ${firstSeg} is hidden from reads`);
}

function assertComponentPerm(
  bit: number,            // R for `t`, W for r/a/d
  firstSeg: string,
  existing: NodeData | undefined,
  userId: string | null,
  claims: string[],
  owner: string | undefined,
): void {
  if (firstSeg.startsWith('$')) return;
  const existingVal = existing?.[firstSeg];
  if (isComponent(existingVal) && !(componentPerm(existingVal, userId, claims, owner) & bit)) {
    throw new OpError('FORBIDDEN', `Access denied: component ${firstSeg}`);
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** Extract a userId from `/auth/users/{userId}` paths — only the user node
 *  itself (no deeper segments) drives a claims rebuild. The auth layout
 *  knowledge lives HERE; sub/ consumes it as an injected detector (gk8.12). */
export function userIdFromAuthPath(path: string): string | null {
  const prefix = '/auth/users/';
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  return rest;
}

// ── Tree wrapper ──

export type AclStore = Tree & {
  /** Cached after get/getChildren — O(1) for already-resolved paths */
  getPerm(path: string): Promise<number>;
};

// MVP read-runtime budgets. Public limit ceiling matches MVP rule 5.
const PUBLIC_LIMIT_MAX = 200;
const PUBLIC_LIMIT_DEFAULT = 100;

export function withAcl(rawStore: Tree, userId: string | null, claims: string[]): AclStore {
  const cache = new Map<string, number>();
  // stateCache: accumulated ACL state per tree level — avoids re-walking shared ancestors
  // within a single request. nodeCache is handled by withCache in the tree pipeline.
  const stateCache = new Map<string, AclState>();

  async function getPerm(path: string): Promise<number> {
    return resolvePermission(rawStore, path, userId, claims, cache, undefined, stateCache);
  }

  // depth>1 fallback: when the caller needs descendants beyond the top
  // level, executeList's depth-1 contract isn't enough yet (MVP rule 1).
  // Use legacy scan+filter+strip until Stage-future deep scanning lands.
  // Same scan-cap warning preserved so operators see the truncation.
  const LEGACY_DEEP_SCAN_LIMIT = 1_000;
  async function legacyDeepGetChildren(
    path: string,
    opts: import('#tree').ChildrenOpts | undefined,
    ctx: unknown,
  ): Promise<Page<NodeData>> {
    // Wrap ctx so query-mount adapters reading via parentStore see the
    // ACL-projected view, not the raw tree — closes the "match raw + strip
    // after" inefficiency (and the timing side-channel that comes with it).
    const rawCtx = withAclQueryTree(ctx, aclStore);
    const raw = await rawStore.getChildren(path, { depth: opts?.depth, limit: LEGACY_DEEP_SCAN_LIMIT }, rawCtx);
    const truncated = raw.items.length >= LEGACY_DEEP_SCAN_LIMIT;
    if (truncated) {
      console.warn(`[acl] getChildren(${path}, depth=${opts?.depth}): hit legacy deep scan limit ${LEGACY_DEEP_SCAN_LIMIT}`);
    }
    const filtered: NodeData[] = [];
    for (const child of raw.items) {
      const perm = await getPerm(child.$path);
      if (!(perm & R)) continue;
      const out = stripComponents(child, userId, claims);
      if (!(perm & A)) {
        delete out.$acl;
        delete out.$owner;
      }
      filtered.push(out);
    }
    const queryTest = opts?.query ? createSiftTest(opts.query) : null;
    const visible = queryTest
      ? filtered.filter(n => queryTest(mapNodeForSift(n)))
      : filtered;
    const result = paginate(visible, opts);
    if (truncated) result.truncated = true;
    if (raw.queryMount) result.queryMount = raw.queryMount;
    return result;
  }

  const aclStore: AclStore = {
    getPerm,
    async get(path, ctx) {
      // Fail loud — same reasoning as getChildren below. Silent `undefined`
      // for a forbidden path makes routers (and SSR) treat it as 404 instead
      // of "auth required", which leads to wrong rendering decisions.
      const perm = await getPerm(path);
      if (!(perm & R)) throw new OpError('FORBIDDEN', `Access denied: ${path}`);
      const node = await rawStore.get(path, ctx);
      if (!node) return undefined;
      const out = stripComponents(node, userId, claims);
      if (!(perm & A)) {
        delete out.$acl;
        delete out.$owner;
      }
      return out;
    },

    async getChildren(path, opts, ctx) {
      // Fail loud, not silent — caller distinguishes "no permission" from
      // "no readable children". Returning [] for a forbidden parent makes
      // routers happily render NotFound instead of LoginScreen.
      const parentPerm = await getPerm(path);
      if (!(parentPerm & R)) throw new OpError('FORBIDDEN', `Access denied: ${path}`);

      const depth = opts?.depth ?? 1;
      // depth>1 fallback: executeList is depth-1 only in MVP. Use legacy
      // scan+filter+strip path with no scan cap (kills ACL_SCAN_LIMIT for
      // depth-1, which is the common case AND the only case that hit it).
      if (depth > 1) return legacyDeepGetChildren(path, opts, ctx);

      // depth=1: route through the new read runtime.
      const source = asTreeSource(rawStore);
      const { plan, legacyQueryMount } = await resolveReadPlan(rawStore, path, opts?.query, ctx);
      // MVP rule 7: a readable query mount over an unreadable source would
      // act as a capability view (child R-grants leak items the actor can't
      // otherwise list). Gate plan.source before scanning. Non-mount path:
      // plan.source === path, parentPerm above already guarded the same path
      // (an extra resolvePermission walk; the assertion runs on a separate
      // cache, so it pays a second ancestor traversal — accept the cost).
      const actor: Actor = { userId, claims };
      await assertSourceReadable(rawStore, actor, plan.source);
      const project = createProjector(rawStore, actor);

      // Public API uses limit + offset + total; executeList uses limit + cursor.
      // Bridge: scan up to LEGACY_DEEP_SCAN_LIMIT visible items to compute
      // total (matches the pre-stage-3 contract). `truncated` surfaces when
      // the scan hit its ceiling — same signal as the old ACL_SCAN_LIMIT
      // warning, just structured into the page instead of console.warn.
      const reqLimit = Math.min(opts?.limit ?? PUBLIC_LIMIT_DEFAULT, PUBLIC_LIMIT_MAX);
      const offset = opts?.offset ?? 0;
      const scanLimit = Math.max(LEGACY_DEEP_SCAN_LIMIT, offset + reqLimit);

      const result = await executeList(source, plan, { limit: scanLimit }, project, ctx);
      const items = result.items.slice(offset, offset + reqLimit);
      const page: Page<NodeData> = { items, total: result.items.length };
      // truncated: either more pages exist (nextCursor) or scan hit budget
      // (result.truncated). Page.total reflects only what we managed to scan.
      if (result.nextCursor || result.truncated) page.truncated = true;
      // queryMount metadata preserved for CDC matrix (sub.ts active query
      // registration). Stage-6 watchQuery consumes the plan directly.
      if (legacyQueryMount) page.queryMount = legacyQueryMount;
      return page;
    },

    async set(node, ctx) {
      const perm = await getPerm(node.$path);
      if (!(perm & W)) throw new OpError('FORBIDDEN', `Access denied: ${node.$path}`);
      const existing = await rawStore.get(node.$path, ctx);
      const safe = { ...node };

      const preserveField = (field: string) => {
        const kept = existing?.[field];
        if (field in safe && !sameValue(safe[field], kept)) {
          throw new OpError('FORBIDDEN', `Access denied: ${field}`);
        }
        if (kept !== undefined) safe[field] = kept;
        else delete safe[field];
      };

      if (!(perm & A)) { preserveField('$acl'); preserveField('$owner'); }

      const owner = safe.$owner ?? existing?.$owner;
      const canWriteComponent = (val: ComponentData) => !!(componentPerm(val, userId, claims, owner) & W);

      for (const [key, oldVal] of Object.entries(existing ?? {})) {
        if (key.startsWith('$') || !isComponent(oldVal) || canWriteComponent(oldVal)) continue;
        if (key in safe && !sameValue(safe[key], oldVal)) {
          throw new OpError('FORBIDDEN', `Access denied: component ${key}`);
        }
        safe[key] = oldVal;
      }

      for (const [key, val] of Object.entries(safe)) {
        if (key.startsWith('$') || !isComponent(val)) continue;
        const oldVal = existing?.[key];
        if (isComponent(oldVal) && !canWriteComponent(oldVal) && sameValue(val, oldVal)) continue;
        if (!canWriteComponent(val)) {
          throw new OpError('FORBIDDEN', `Access denied: component ${key}`);
        }
      }

      return rawStore.set(safe, ctx);
    },

    async remove(path, ctx) {
      const perm = await getPerm(path);
      if (!(perm & W)) throw new OpError('FORBIDDEN', `Access denied: ${path}`);
      return rawStore.remove(path, ctx);
    },

    async patch(path, ops, ctx) {
      const perm = await getPerm(path);
      // Patch = read-modify-write. R+W gate closes the test-op oracle (no R →
      // no probing via [t, $field, guess]). Per-op checks below cover hidden
      // $-fields, hidden components, and $owner mutation in the same batch.
      if (!((perm & R) && (perm & W))) {
        throw new OpError('FORBIDDEN', `Access denied: ${path}`);
      }

      const isAdmin = !!(perm & A);
      const existing = await rawStore.get(path, ctx);   // may be undefined
      // Track owner across the batch so component checks see post-mutation $owner
      // (parity with set() at lines 367-383).
      let currentOwner = existing?.$owner;

      for (const op of ops) {
        assertSafePatchPath(op[1]);
        const segments = op[1].split('.');
        const firstSeg = segments[0];

        // Apply system-field rule to EVERY $-segment at any depth: prevents
        // component-envelope bypass like `[r, secret.$acl, …]` followed by
        // mutations to secret.* under stale ACL.
        if (op[0] === 't') {
          for (const seg of segments) if (seg.startsWith('$')) assertTestSystemField(seg, isAdmin);
          assertComponentPerm(R, firstSeg, existing, userId, claims, currentOwner);
          continue;
        }

        // r/a/d — mutation
        for (const seg of segments) if (seg.startsWith('$')) assertMutationSystemField(seg, isAdmin);
        assertComponentPerm(W, firstSeg, existing, userId, claims, currentOwner);

        // Incoming new component value (single-segment r/a) needs W on the new value.
        if ((op[0] === 'r' || op[0] === 'a') && op[1] === firstSeg) {
          const newVal = (op as readonly ['r' | 'a', string, unknown])[2];
          if (isComponent(newVal) && !(componentPerm(newVal, userId, claims, currentOwner) & W)) {
            throw new OpError('FORBIDDEN', `Access denied: cannot write component ${firstSeg}`);
          }
        }

        // Update tracked $owner for subsequent component checks in this batch.
        // `a` is also a setter (patch.ts:58-66); `d` clears.
        if ((op[0] === 'r' || op[0] === 'a') && op[1] === '$owner') {
          currentOwner = op[2] as string | undefined;
        } else if (op[0] === 'd' && op[1] === '$owner') {
          currentOwner = undefined;
        }
      }

      return rawStore.patch(path, ops, ctx);
    },
  };
  return aclStore;
}
