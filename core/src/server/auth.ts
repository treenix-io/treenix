// Treenity Auth — ACL on nodes
// Group-based permissions, tree inheritance, deny-is-sticky.
// Tree wrapper: resolves ACL per path, strips forbidden components.

import {
  A,
  type ComponentData,
  type GroupPerm,
  isComponent,
  type NodeData,
  R,
  resolve as resolveHandler,
  S,
  W,
} from '#core';
import { paginate, type Tree } from '#tree';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export type AclHandler = () => GroupPerm[];

declare module '#core/context' {
  interface ContextHandlers {
    acl: AclHandler;
  }
}

// ── Types ──

export type Session = { userId: string; claims?: string[] };

// Session nodes are stored as regular nodes with extra fields
type SessionNode = NodeData & { userId: string; createdAt: number; expiresAt: number; claims?: string[] };

// ── Sessions (tree-backed, /auth/sessions/{token}) ──

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function createSession(
  tree: Tree,
  userId: string,
  opts?: { ttlMs?: number; claims?: string[] },
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const sessionNode: SessionNode = {
    $path: `/auth/sessions/${token}`, $type: 'session',
    $acl: [{ g: 'admins', p: R | W | A | S }],
    userId, createdAt: now, expiresAt: now + (opts?.ttlMs ?? SESSION_TTL_MS),
    ...(opts?.claims && { claims: opts.claims }),
  };
  await tree.set(sessionNode);
  return token;
}

export async function resolveToken(tree: Tree, token: string): Promise<Session | null> {
  // B03: reject non-hex tokens to prevent path traversal via /auth/sessions/../../
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const node = await tree.get(`/auth/sessions/${token}`) as SessionNode | undefined;
  if (!node) return null;
  if (!node.userId || !node.expiresAt) {
    console.error(`[auth] corrupt session: ${token} (missing userId or expiresAt)`);
    await tree.remove(`/auth/sessions/${token}`);
    return null;
  }
  if (Date.now() > node.expiresAt) {
    await tree.remove(`/auth/sessions/${token}`);
    return null;
  }
  return { userId: node.userId, ...(node.claims && { claims: node.claims }) };
}

export async function revokeSession(tree: Tree, token: string): Promise<boolean> {
  return tree.remove(`/auth/sessions/${token}`);
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

  let effective = 0;
  for (const v of state.groupPerms.values()) {
    if (v > effective) effective = v;
  }
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
    let best = 0;
    for (const p of groupPerms.values()) {
      if (p > best) best = p;
    }
    effective &= best;
  }
  return effective;
}

export function stripComponents(node: NodeData, userId: string | null, claims: string[]): NodeData {
  const out: NodeData = { $path: node.$path, $type: node.$type };
  if (node.$acl) out.$acl = node.$acl;
  if (node.$owner) out.$owner = node.$owner;
  if (node.$rev !== undefined) out.$rev = node.$rev;
  if ('$ref' in node) out['$ref'] = node['$ref'];
  if ('$patches' in node) out['$patches'] = node['$patches'];
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    if (!isComponent(val)) { out[key] = val; continue; }
    if (componentPerm(val, userId, claims, node.$owner) & R) out[key] = val;
  }
  return out;
}

// ── Build claims ──

export async function buildClaims(tree: Tree, userId: string): Promise<string[]> {
  const group = userId.startsWith('anon:') ? 'public' : 'authenticated';
  const claims = [`u:${userId}`, group];
  const userNode = await tree.get(`/auth/users/${userId}`);
  if (userNode) {
    const gv = userNode['groups'];
    const groups = isComponent(gv) ? gv : undefined;
    if (Array.isArray(groups?.['list'])) claims.push(...groups['list']);
  }
  return claims;
}

// ── Tree wrapper ──

export type AclStore = Tree & {
  /** Cached after get/getChildren — O(1) for already-resolved paths */
  getPerm(path: string): Promise<number>;
};

export function withAcl(rawStore: Tree, userId: string | null, claims: string[]): AclStore {
  const cache = new Map<string, number>();
  // stateCache: accumulated ACL state per tree level — avoids re-walking shared ancestors
  // within a single request. nodeCache is handled by withCache in the tree pipeline.
  const stateCache = new Map<string, AclState>();

  async function getPerm(path: string): Promise<number> {
    return resolvePermission(rawStore, path, userId, claims, cache, undefined, stateCache);
  }

  return {
    getPerm,
    async get(path, ctx) {
      const perm = await getPerm(path);
      if (!(perm & R)) return undefined;
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
      const MAX_ACL_SCAN = 10_000;
      // Fetch up to limit from underlying — ACL filters first, then paginate
      const raw = await rawStore.getChildren(path, { depth: opts?.depth, limit: MAX_ACL_SCAN }, ctx);
      const truncated = raw.items.length >= MAX_ACL_SCAN;
      if (truncated) {
        console.warn(`[acl] getChildren(${path}): hit scan limit ${MAX_ACL_SCAN}, results may be incomplete`);
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
      // Preserve queryMount for CDC Matrix (sub.ts active query registration)
      const result = paginate(filtered, opts);
      if (truncated) result.truncated = true;
      if (raw.queryMount) result.queryMount = raw.queryMount;
      return result;
    },

    async set(node, ctx) {
      const perm = await getPerm(node.$path);
      if (!(perm & W)) throw new Error(`Access denied: ${node.$path}`);
      const existing = await rawStore.get(node.$path, ctx);
      const safe = { ...node };
      // Non-admin: preserve existing $acl/$owner
      if (!(perm & A)) {
        if (existing?.$acl) safe.$acl = existing.$acl;
        else delete safe.$acl;
        if (existing?.$owner) safe.$owner = existing.$owner;
        else delete safe.$owner;
      }
      // Protect components: if user lacks W on a component, keep old value
      const owner = safe.$owner ?? existing?.$owner;
      for (const [key, val] of Object.entries(safe)) {
        if (key.startsWith('$')) continue;
        if (!isComponent(val)) continue;
        if (!(componentPerm(val, userId, claims, owner) & W)) {
          // User can't write this component — restore old value or remove
          if (existing && key in existing) safe[key] = existing[key];
          else delete safe[key];
        }
      }
      // Also restore protected components the user may have omitted
      if (existing) {
        for (const [key, val] of Object.entries(existing)) {
          if (key.startsWith('$')) continue;
          if (!isComponent(val)) continue;
          if (!(componentPerm(val, userId, claims, owner) & W) && !(key in safe))
            safe[key] = val;
        }
      }
      return rawStore.set(safe, ctx);
    },

    async remove(path, ctx) {
      const perm = await getPerm(path);
      if (!(perm & W)) throw new Error(`Access denied: ${path}`);
      return rawStore.remove(path, ctx);
    },

    async patch(path, ops, ctx) {
      const perm = await getPerm(path);
      if (!(perm & W)) throw new Error(`Access denied: ${path}`);
      return rawStore.patch(path, ops, ctx);
    },
  };
}
