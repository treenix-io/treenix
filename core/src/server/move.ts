// move() — relocate a node (and its subtree) atomically, leaving 'moved'
// tombstones behind (core-gk8.10 stage 2). Identity ($id) travels to the new
// path; each tombstone echoes the moved node's $id (write pipeline stored-id
// echo) so resolveRef can verify it follows the right chain. One patchMany
// batch = all-or-nothing; destination members are ordered BEFORE tombstones
// so a crash mid-batch (fs) leaves duplicated content, never broken refs
// (same ordering rule as trash copy-before-remove).
//
// Same-authority rename only: patchMany refuses to span storage layers or
// mount boundaries — cross-mount relocation is a copy+delete with different
// semantics (POSIX rename EXDEV precedent), not a move.

import { assertSafePath, commonAncestor, isChildPath, isMoved, type NodeData } from '#core';
import { OpError } from '#errors';
import { asTreeSource, type PatchManyEntry, type Tree } from '#tree';
import { relocateCtx } from '#tree/policy';
import { commit, mutationLock } from './commit';

/** Batch cap: the commit envelope acquires one lock per member path and both
 *  scan buffers live in memory — an unbounded subtree move is a liveness
 *  hazard, not a feature. Bigger relocations are an offline migration. */
const MOVE_MAX_NODES = 500;

export type MoveResult = { moved: number; from: string; to: string };

export async function move(tree: Tree, from: string, to: string, ctx?: unknown): Promise<MoveResult> {
  assertSafePath(from);
  assertSafePath(to);
  if (from === '/') throw new OpError('BAD_REQUEST', 'move: cannot move the root');
  if (to === '/') throw new OpError('BAD_REQUEST', 'move: destination cannot be the root');
  if (to === from) throw new OpError('BAD_REQUEST', 'move: destination equals source');
  if (isChildPath(from, to, false)) throw new OpError('BAD_REQUEST', `move: destination ${to} is inside the moved subtree ${from}`);

  // Subtree spans over source AND destination, sorted, held from the first
  // scan through the commit (core-anz4.5): a concurrent in-process write under
  // either prefix parks until the span ends (or CONFLICTs by lock order)
  // instead of landing in the scan→commit window — no orphan left under a
  // tombstone, no foreign node adopted mid-move.
  const [lo, hi] = from < to ? [from, to] : [to, from];
  return mutationLock.subtree(lo, () => mutationLock.subtree(hi, () => moveLocked(tree, from, to, ctx)));
}

async function moveLocked(tree: Tree, from: string, to: string, ctx?: unknown): Promise<MoveResult> {
  const src = asTreeSource(tree);

  const root = await tree.get(from, ctx);
  if (!root) throw new OpError('NOT_FOUND', `move: ${from} not found`);
  if (isMoved(root)) throw new OpError('BAD_REQUEST', `move: ${from} is a tombstone`);

  // scanChildren yields descendants only — the root travels separately.
  const nodes: NodeData[] = [root];
  for await (const e of src.scanChildren(from, { depth: -1 }, ctx)) {
    nodes.push(e.node);
    if (nodes.length > MOVE_MAX_NODES) {
      throw new OpError('BAD_REQUEST', `move: subtree exceeds ${MOVE_MAX_NODES} nodes — relocate offline`);
    }
  }

  // Destination must be vacant — EXCEPT a tombstone carrying the id of the
  // exact node landing on that path (move-back/undo: replacing it makes every
  // chain through it terminate at the real node, self-consistently). A
  // foreign tombstone stays protected: overwriting it would cut someone
  // else's redirect chain.
  const idByDest = new Map(nodes.map(n => [to + n.$path.slice(from.length), n.$id]));
  const assertVacant = (taken: NodeData) => {
    if (isMoved(taken) && taken.$id !== undefined && taken.$id === idByDest.get(taken.$path)) return;
    throw new OpError('CONFLICT', `move: destination is not empty (${taken.$path})`);
  };
  const destRoot = await tree.get(to, ctx);
  if (destRoot) assertVacant(destRoot);
  for await (const taken of src.scanChildren(to, { depth: -1 }, ctx)) {
    assertVacant(taken.node);
  }

  // Tombstones inside the moved subtree travel as ordinary nodes: their
  // absolute $ref stays valid, and the old location chains through the new
  // tombstone — resolveRef follows both hops.
  const dests: PatchManyEntry[] = [];
  const stones: PatchManyEntry[] = [];
  for (const n of nodes) {
    const dest = to + n.$path.slice(from.length);
    const { $rev, ...data } = n;

    // Carried $id at a new path — the stage-1 relocation contract. $rev is
    // stripped: the destination store never issued one (vacancy pre-checked
    // above; the subtree spans cover the window).
    dests.push({ path: dest, node: { ...data, $path: dest } });

    // Tombstone: id-less on purpose — the pipeline echoes the stored $id.
    // $acl/$owner carried so the old path keeps its protection (a moved
    // secret must not leak its new location to readers the node denied).
    // $rev = OCC: any concurrent write to the subtree denies the whole batch.
    const stone: NodeData = { $path: n.$path, $type: 'moved', $ref: dest };
    if (n.$acl) stone.$acl = n.$acl;
    if (n.$owner) stone.$owner = n.$owner;
    if ($rev != null) stone.$rev = $rev;
    stones.push({ path: n.$path, node: stone });
  }

  // relocateCtx: the dests carry stored $id to new paths — the trusted
  // relocation the policy's $id gate demands (core-anz4.2).
  await commit(tree, commonAncestor(from, to), [...dests, ...stones], relocateCtx(ctx));
  return { moved: nodes.length, from, to };
}
