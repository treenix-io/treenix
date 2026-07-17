// Branch mod — write-isolated futures over the live tree.
// Overlay mechanics live in @treenx/core/tree/branch (Layer 1); this mod owns
// the node types and lifecycle actions. The mount adapter, control window and
// agent scope live in service.ts (server-only — pulls node:crypto via
// security/*; this file is a client convention entry and must stay isomorphic).
// Lifecycle: create → work under /branches/<id>/tree → diff →
// requestMerge (human reviews) → merge | abandon.

import { A, isRef, makeNode, type NodeData, R, S, W } from '@treenx/core';
import { getCtx, registerType } from '@treenx/core/comp';
import { OpError } from '@treenx/core/errors';
import type { ActorContext } from '@treenx/core/server/actions';
import { type PatchManyEntry, relocateCtx, type Tree } from '@treenx/core/tree';
import { isBranchDelta, isBranchWhiteout } from '@treenx/core/tree/branch';

export type BranchStatus = 'open' | 'review' | 'merged' | 'conflict' | 'abandoned';

export type DiffEntry = {
  /** Live target path (branch base + path inside the view). */
  path: string;
  op: 'create' | 'set' | 'remove' | 'noop';
  baseRev: number | null;
  /** Future node for create/set. */
  node?: NodeData;
};

export type ConflictEntry = { path: string; expectedRev: number | null; actualRev: number | null };

// Actions invoked through the /.branch control window carry the WINDOW path as
// node identity; delta/live live at the real branch path. (Branch-rooted
// sessions cannot reach the delta at all — their /.branch executes are
// re-targeted to the real path by the MCP layer before they get here.)
const SELF_SUFFIX = '/tree/.branch';

function realBranchPath(nodePath: string): string {
  return nodePath.endsWith(SELF_SUFFIX) ? nodePath.slice(0, -SELF_SUFFIX.length) : nodePath;
}

// Thread the action's actor into tree writes so withAudit records the span
// (one requestId per merge). Structural check + boundary cast — ExecCtx keys
// are untyped (same decode pattern as audit's getActor).
function actorCtxOf(ctx: { [k: string]: unknown }): { actor: ActorContext } | undefined {
  const a = ctx.actor;
  if (a && typeof a === 'object' && 'id' in a) return { actor: a as ActorContext };
  return undefined;
}

// core-anz4.22: refs written through the view carry VIEW coordinates
// (<branch>/tree/...) — merge relocates nodes to the base namespace, so refs
// targeting INSIDE the view must move with them or they dangle once the
// branch mount is gone. Refs deliberately pointing outside the view stay
// untouched. $refId rides along unchanged — identity merges WITH the target
// node, so id-first resolution keeps working. Standalone $refs entries (no
// f:) are rewritten too: the policy passes them through as-is on merge, while
// derived entries get recomputed from the rewritten fields. Clone first —
// adapters may hand out shared references.
function rewriteViewRefs(node: NodeData, viewRoot: string, base: string): NodeData {
  const mapTarget = (p: string): string | undefined => {
    if (p !== viewRoot && !p.startsWith(viewRoot + '/')) return undefined;
    const rest = p.slice(viewRoot.length);
    return base === '/' ? (rest || '/') : base + rest;
  };

  const clone = structuredClone(node);

  // Same traversal shape as the policy's extractRefs: skip $-keys, walk
  // component keys and plain data alike.
  const walk = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    if (isRef(obj)) {
      const mapped = mapTarget(obj.$ref);
      if (mapped !== undefined) obj.$ref = mapped;
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('$')) continue;
      walk(value);
    }
  };
  walk(clone);

  for (const entry of clone.$refs ?? []) {
    const mapped = mapTarget(entry.t);
    if (mapped !== undefined) entry.t = mapped;
  }

  return clone;
}

// Shared by diff/merge — action methods run on an Immer draft of node DATA
// (class methods are not callable via `this` there).
async function collectDiff(tree: Tree, branchPath: string, base: string): Promise<DiffEntry[]> {
  const deltaRoot = `${branchPath}/delta`;
  const viewRoot = `${branchPath}/tree`;
  if (!tree.scanChildren) {
    throw new OpError('BAD_REQUEST', 'branch.diff requires a tree with scanChildren');
  }

  const entries: DiffEntry[] = [];
  for await (const { node: w } of tree.scanChildren(deltaRoot, { depth: -1 })) {
    const rest = w.$path.slice(deltaRoot.length);
    const livePath = base === '/' ? (rest || '/') : base + rest;
    if (isBranchWhiteout(w)) {
      entries.push({ path: livePath, op: w.baseRev === null ? 'noop' : 'remove', baseRev: w.baseRev });
    } else if (isBranchDelta(w)) {
      entries.push({
        path: livePath,
        op: w.baseRev === null ? 'create' : 'set',
        baseRev: w.baseRev,
        node: { ...rewriteViewRefs(w.node, viewRoot, base), $path: livePath },
      });
    } else {
      throw new OpError('CONFLICT', `branch: foreign node in delta subtree at ${w.$path} ($type=${w.$type})`);
    }
  }
  return entries;
}

/** Container at /branches — branches are created through it, never by hand. */
export class Branches {
  /** @description Create a branch: t.branch node + delta store + mounted view */
  async create(data?: { title?: string; owner?: string; base?: string }) {
    const ctx = getCtx();
    const callerUserId = typeof ctx.userId === 'string' ? ctx.userId : undefined;
    const owner = data?.owner ?? callerUserId;
    if (!owner) throw new OpError('BAD_REQUEST', 'branch owner required (no session user and no explicit owner)');

    const id = `b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const path = `${ctx.node.$path}/${id}`;

    const branchNode = makeNode(path, 't.branch', {
      base: data?.base ?? '/',
      owner,
      status: 'open' as const,
      title: data?.title ?? '',
      createdAt: Date.now(),
      mergedAt: 0,
      conflicts: [] as ConflictEntry[],
    });
    branchNode.$acl = [
      { g: 'admins', p: R | W | A | S },
      { g: `u:${owner}`, p: R | W | A | S },
    ];
    await ctx.tree.set(branchNode);
    await ctx.tree.set(makeNode(`${path}/delta`, 'dir'));
    await ctx.tree.set(makeNode(`${path}/tree`, 'dir', undefined, {
      mount: { $type: 't.mount.branch' },
    }));
    return { path };
  }
}

/** A write-isolated future. Work happens under `<path>/tree`; every write is
 *  captured under `<path>/delta` and the live tree stays untouched until merge. */
export class Branch {
  base = '/';
  owner = '';
  status: BranchStatus = 'open';
  title = '';
  createdAt = 0;
  mergedAt = 0;
  conflicts: ConflictEntry[] = [];

  /** @description List the branch's changes against live (does not mutate) */
  async diff(): Promise<{ entries: DiffEntry[] }> {
    const ctx = getCtx();
    return { entries: await collectDiff(ctx.tree, realBranchPath(ctx.node.$path), this.base) };
  }

  /** @description Close the branch without merging. Delta stays as the record. */
  abandon() {
    if (this.status === 'merged') throw new OpError('CONFLICT', 'cannot abandon a merged branch');
    this.status = 'abandoned';
  }

  /** @description Mark the branch ready for human review and merge.
   *  Status is the source of truth; the approval inbox entry is filed by the
   *  orchestrator watcher (fileMergeApprovals) as a REACTION to status=review —
   *  a dual write from here would land in the branch's own delta when invoked
   *  through a branch-rooted session (/.branch). */
  requestMerge(data?: { note?: string }) {
    if (this.status !== 'open') {
      throw new OpError('CONFLICT', `cannot request merge in status "${this.status}"`);
    }
    if (data?.note) this.title = this.title ? `${this.title} — ${data.note}` : data.note;
    this.status = 'review';
    return { status: 'review' as const };
  }

  /** @description Merge the branch into live. Run by an approver — agents hold
   *  no live W, so the human invoking this IS the gate. Preflight checks every
   *  entry against its captured baseRev; any mismatch reports conflicts and
   *  applies NOTHING. Apply is ONE tree.patchMany batch (core-anz4.6): each
   *  set-member carries $rev = baseRev, so a writer slipping in after
   *  preflight fails adapter OCC during staging and the WHOLE batch is denied
   *  — never a partial merge. Remove entries are refused before any write:
   *  PatchManyEntry has no remove member, and applying removes outside the
   *  batch would reopen the partial-merge hole (remove-merge parked). */
  async merge() {
    if (this.status !== 'open' && this.status !== 'review') {
      throw new OpError('CONFLICT', `cannot merge branch in status "${this.status}"`);
    }
    const ctx = getCtx();
    const tree = ctx.tree;
    const entries = await collectDiff(tree, realBranchPath(ctx.node.$path), this.base);

    // Loud refusals BEFORE any write and before any status change.
    const removes = entries.filter(e => e.op === 'remove').map(e => e.path);
    if (removes.length) {
      throw new OpError('BAD_REQUEST',
        `branch merge with remove entries is not supported yet (remove-merge parked): ${removes.join(', ')}`);
    }
    if (!tree.patchMany) {
      throw new OpError('BAD_REQUEST', 'branch merge requires a tree with patchMany (atomic batch)');
    }

    const findConflicts = async (): Promise<ConflictEntry[]> => {
      const found: ConflictEntry[] = [];
      for (const e of entries) {
        const live = await tree.get(e.path);
        const actualRev = live?.$rev ?? null;
        const ok = (e.op === 'create' || e.op === 'noop')
          ? live === undefined
          : actualRev === e.baseRev;
        if (!ok) found.push({ path: e.path, expectedRev: e.baseRev, actualRev });
      }
      return found;
    };

    const conflicts = await findConflicts();
    if (conflicts.length) {
      this.status = 'conflict';
      this.conflicts = conflicts;
      return { merged: 0, applied: [] as string[], conflicts };
    }

    // Compile the batch: set-members only. Creates (baseRev null) have no rev
    // token to guard with — blind-upsert residual, narrowed by the preflight
    // existence check above. Cross-mount members are refused by the mounts
    // layer before anything commits.
    const members: PatchManyEntry[] = [];
    for (const e of entries) {
      if (e.op === 'noop') continue;
      const future = e.node;
      if (!future) throw new OpError('CONFLICT', `merge: entry ${e.path} is missing its node`);
      const node: NodeData = { ...future, $path: e.path };
      if (e.baseRev !== null) node.$rev = e.baseRev;
      members.push({ path: e.path, node });
    }

    // Status flip rides the SAME batch (anz4.6 review): a second commit could
    // crash between "live merged" and "branch closed", leaving an open branch
    // over already-merged data. OCC-guarded by the branch node's rev; the
    // Immer draft stays untouched on success so the action framework does not
    // issue a competing second write. Ancestor is '/' — branch node and base
    // live in the root store; a mounted base fails the cross-mount check LOUD
    // (atomicity across stores is physically impossible — not merged blind).
    const branchPath = realBranchPath(ctx.node.$path);
    const branchRev = ctx.node.$rev;
    const mergedAt = Date.now();
    if (typeof branchRev !== 'number') {
      throw new OpError('CONFLICT', `merge: branch node ${branchPath} has no $rev to guard the status flip`);
    }
    members.push({
      path: branchPath,
      ops: [
        ['t', '$rev', branchRev],
        ['r', 'status', 'merged'],
        ['r', 'mergedAt', mergedAt],
        ['r', 'conflicts', []],
      ],
    });

    try {
      // actorCtxOf: one requestId across the whole span (withAudit).
      // relocateCtx (anz4.2): created-in-branch nodes minted their $id at the
      // VIEW path — carrying it to the live path is the sanctioned relocation
      // (without the marker the pipeline rejects the whole merge).
      await tree.patchMany!('/', members, relocateCtx(actorCtxOf(ctx)));
    } catch (err) {
      // OCC slip after preflight is the expected race — the batch was denied
      // whole, so re-read live and report the drift. Anything else (layer
      // without patchMany, cross-mount member, validation) rethrows loud.
      if (err instanceof OpError && err.code === 'CONFLICT') {
        const raced = await findConflicts();
        if (raced.length) {
          this.status = 'conflict';
          this.conflicts = raced;
          return { merged: 0, applied: [] as string[], conflicts: raced };
        }
      }
      throw err;
    }

    // Storage already holds status='merged' from the batch. The draft stays
    // UNTOUCHED on this path — mutating it would make the action framework
    // issue a second commit against the rev the batch just bumped (CONFLICT).
    // The result reports from locals; the last member is the status flip.
    const applied = members.slice(0, -1).map(m => m.path);
    return { merged: applied.length, applied, conflicts: [] as ConflictEntry[], status: 'merged' as const };
  }
}

registerType('t.branches', Branches);
registerType('t.branch', Branch);

// The mount adapter for the merged view lives in service.ts (server-only);
// the class is here so schemas/catalog see the type on both ends.
export class MountBranch {}
registerType('t.mount.branch', MountBranch);

// The branch's own control window path (Plan9 /proc/self) — service.ts mounts
// it; realBranchPath above unwraps it on action targets.
export const BRANCH_SELF = '.branch';
