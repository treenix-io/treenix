// Treenix Projector — security
// Per-node ACL projection: raw node → visible node, or null when actor
// cannot read. Used by executeList (server-internal read runtime) and
// anywhere a single-node visibility decision is needed without wrapping the
// whole Tree via withAcl.
//
// Mirrors withAcl.get's stripping logic but takes an already-fetched node so
// callers (scanChildren loops) don't pay a second tree.get round-trip.

import { A, R, type NodeData } from '#core';
import { OpError } from '#errors';
import type { Tree } from '#tree';
import type { Projector } from '#tree/read-runtime';
import { resolvePermission, stripComponents } from './auth';

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
    if (!(perm & R)) return null;
    const out = stripComponents(node, actor.userId, actor.claims);
    if (!(perm & A)) {
      delete out.$acl;
      delete out.$owner;
    }
    return out;
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
