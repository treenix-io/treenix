// ── ACL resolution primitives ──
// Group-based permissions, tree inheritance, deny-is-sticky.
// resolvePermission walks ancestors; componentPerm/stripComponents gate components.

import {
  A,
  type ComponentData,
  type GroupPerm,
  isCompKey,
  isComponent,
  type NodeData,
  R,
  resolve as resolveHandler,
  W,
} from '#core';
import type { Tree } from '#tree';

export type AclHandler = () => GroupPerm[];

declare module '#core/context' {
  interface ContextHandlers {
    acl: AclHandler;
  }
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
export type AclState = {
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
    // Strict namespace: only '#' keys are components. Bare keys are node body
    // (data, incl. $type-carrying snapshots) — node-level R already covers them.
    if (!isCompKey(key)) { out[key] = val; continue; }
    if (!isComponent(val)) {
      // '#'-key without $type = malformed write slipped past the barrier.
      // Fail closed AND loud — emitting it would leak an unclassifiable value.
      throw new Error(`stripComponents: malformed component entry "${key}" on ${node.$path}`);
    }
    if (componentPerm(val, userId, claims, node.$owner) & R) out[key] = val;
  }
  return out;
}
