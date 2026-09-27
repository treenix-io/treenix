// Treenix Projector — security
// Per-node ACL projection: raw node → visible node, or null when actor
// cannot read. Used by executeList (server-internal read runtime) and
// anywhere a single-node visibility decision is needed without wrapping the
// whole Tree via withAcl.
//
// Mirrors withAcl.get's stripping logic but takes an already-fetched node so
// callers (scanChildren loops) don't pay a second tree.get round-trip.

import { R, type NodeData } from '#core';
import { OpError } from '#errors';
import type { MembershipProjector } from '#sub';
import type { Tree } from '#tree';
import type { Projector } from '#tree/read-runtime';
import { projectNode, resolvePermission } from './acl';
import { buildClaims } from './claims';

export type Actor = {
  userId: string | null;
  claims: string[];
};

/** Returns a function that, given a raw node, returns either the visible
 *  (ACL-stripped) projection or null if the actor lacks R on the node's path.
 *  The closed-over `cache` makes ancestor permission resolution O(1)
 *  amortised across calls for a single executeList scan. */
export function createProjector(tree: Tree, actor: Actor): Projector {
  const cache = new Map<string, number>();
  return async (node: NodeData): Promise<NodeData | null> => {
    const perm = await resolvePermission(tree, node.$path, actor.userId, actor.claims, cache);
    return perm & R ? projectNode(node, perm, actor.userId, actor.claims) : null;
  };
}

// Same freshness window as the event-lane ACL filter (watch-filter.ts).
const MEMBERSHIP_CLAIMS_TTL_MS = 30_000;

/** F4 actor-projected membership (core-anz4.3): project a commit's (old, new)
 *  node pair as `userId` may read it — query-watch membership eval runs on
 *  THIS, never on the raw node. Claims are TTL-cached per user (event-filter
 *  parity); permissions and component stripping resolve fresh per call, so an
 *  ACL change never serves a stale membership verdict. Old and new share one
 *  projector instance — same path, one ancestor-permission walk. */
export function createMembershipProjector(
  tree: Tree,
  claimsTree: Tree,
  opts?: { claimsTtlMs?: number },
): MembershipProjector {
  const claimsTtlMs = opts?.claimsTtlMs ?? MEMBERSHIP_CLAIMS_TTL_MS;
  const claimsCache = new Map<string, { claims: string[]; at: number }>();

  async function claimsFor(userId: string): Promise<string[]> {
    const hit = claimsCache.get(userId);
    if (hit && Date.now() - hit.at <= claimsTtlMs) return hit.claims;
    // Lazy prune bounds the map by ACTIVE watchers, not all-time users.
    if (claimsCache.size >= 1024) {
      for (const [k, v] of claimsCache) if (Date.now() - v.at > claimsTtlMs) claimsCache.delete(k);
    }
    const claims = await buildClaims(claimsTree, userId);
    claimsCache.set(userId, { claims, at: Date.now() });
    return claims;
  }

  return async (userId, oldNode, newNode) => {
    const project = createProjector(tree, { userId, claims: await claimsFor(userId) });
    return [oldNode ? await project(oldNode) : null, newNode ? await project(newNode) : null];
  };
}

/** Source-readability gate (MVP rule 7: no capability views over unreadable
 *  sources). Used before executeList to fail loud — same reasoning as
 *  withAcl.getChildren: silent empty page would let routers render NotFound
 *  for what is actually "auth required". */
export async function assertSourceReadable(tree: Tree, actor: Actor, path: string): Promise<void> {
  const perm = await resolvePermission(tree, path, actor.userId, actor.claims);
  if (!(perm & R)) throw new OpError('FORBIDDEN', `Source not readable: ${path}`);
}
