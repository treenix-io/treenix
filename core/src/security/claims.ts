// ── Claims — identity groups an actor carries ──
// SYSTEM_CLAIM gate + buildClaims (user node groups) + auth-path detector.

import { getComponent, type NodeData } from '#core';
import { KernelError } from '#errors';
import type { Tree } from '#tree';

/** Reserved claim/userId for bootstrap-only ACL bypass via root grant.
 *  Must NEVER appear in a user-facing session or claim list — every API that
 *  could mint a session, build claims, or accept a user-supplied id must reject it. */
export const SYSTEM_CLAIM = 'system';

export function assertNotSystem(userId: string, claims?: readonly string[]): void {
  if (userId === SYSTEM_CLAIM) throw new KernelError('FORBIDDEN', 'reserved userId');
  if (claims && claims.includes(SYSTEM_CLAIM)) throw new KernelError('FORBIDDEN', 'reserved claim');
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
