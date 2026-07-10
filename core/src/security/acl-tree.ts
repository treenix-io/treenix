// ── withAcl — the per-actor Tree wrapper ──
// Resolves ACL per path, strips forbidden components, gates every verb.
// The read path (any depth) routes through the executeList read runtime.

import { A, type ComponentData, isComponent, type NodeData, R, W } from '#core';
import { OpError } from '#errors';
import { asTreeSource, assertSafePatchPath, isSetEntry, type Page, type PatchManyEntry, type PatchOp, type Tree } from '#tree';
import { executeList } from '#tree/read-runtime';
import { resolveReadPlan } from '#mount/resolve-plan';
import { type AclState, componentPerm, resolvePermission, stripComponents } from './acl';
import { type Actor, assertSourceReadable, createProjector } from './projector';

// ── Patch op rules ──
// Mirrors stripComponents visibility (acl.ts):
//   $path/$type/$rev/$id/$ref/$refId always visible → t allowed; only
//   $ref/$refId mutable — they retarget/repair together (resolveRef
//   self-repair patches both; a frozen $refId under a mutable $ref would
//   desync the pair).
//   $acl/$owner visible only with A → both gates require A.
//   $refs always stripped → both ops forbidden (oracle).
//   other $-fields → forbidden (unknown system fields).
function assertMutationSystemField(firstSeg: string, isAdmin: boolean): void {
  if (!firstSeg.startsWith('$')) return;
  if (firstSeg === '$ref' || firstSeg === '$refId') return;
  if (firstSeg === '$acl' || firstSeg === '$owner') {
    if (isAdmin) return;
    throw new OpError('FORBIDDEN', `Access denied: ${firstSeg} requires A permission`);
  }
  throw new OpError('FORBIDDEN', `Access denied: ${firstSeg} is system-managed`);
}

function assertTestSystemField(firstSeg: string, isAdmin: boolean): void {
  if (!firstSeg.startsWith('$')) return;
  if (firstSeg === '$path' || firstSeg === '$type' || firstSeg === '$rev' || firstSeg === '$ref' || firstSeg === '$refId' || firstSeg === '$id') return;
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

/** Per-op ACL gate shared by patch and patchMany (per member): system-field
 *  assertions, component perms, $owner tracking across the batch. */
function assertPatchOps(
  ops: readonly PatchOp[],
  existing: NodeData | undefined,
  isAdmin: boolean,
  userId: string | null,
  claims: string[],
): void {
  // Track owner across the batch so component checks see post-mutation $owner
  // (parity with set()).
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
}

/** ACL rewrite for a full-node write (shared by set() and patchMany
 *  set-members): $acl/$owner must survive unchanged without A, existing
 *  non-writable components are restored (silent echo) or denied (altered),
 *  incoming component values need W. Returns the safe node to forward. */
function rewriteFullNodeWrite(
  node: NodeData,
  existing: NodeData | undefined,
  perm: number,
  userId: string | null,
  claims: string[],
): NodeData {
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

  return safe;
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

  // Actor stamping (core-3j54): this wrap is where principal identity binds, so
  // every mutation forwarded below carries WHO — direct verbs (tRPC/TWP set,
  // patch, rm, setComponent, deployPrefab) were anonymous in the audit journal
  // otherwise. A caller-supplied ctx.actor wins: it is richer (action/requestId
  // from the executor) and only in-process code can pass ctx — the wire never
  // threads client data here beyond opId, which becomes requestId.
  function stampActor(ctx: unknown): unknown {
    if (!userId) return ctx;
    if (ctx === undefined || ctx === null) return { actor: { id: userId } };
    if (typeof ctx !== 'object') return ctx;
    const c = ctx as Record<string, unknown>;
    if (c.actor) return ctx;
    const opId = typeof c.opId === 'string' ? c.opId : undefined;
    return { ...c, actor: { id: userId, ...(opId ? { requestId: opId } : {}) } };
  }

  async function getPerm(path: string): Promise<number> {
    return resolvePermission(rawStore, path, userId, claims, cache, undefined, stateCache);
  }

  // INVARIANT (core-pxlu): hand-built literal, NO `...rawStore` spread — the
  // execute capability is intentionally stripped here; the wire session
  // re-wraps with withExecute binding the correct per-request identity.
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

      const source = asTreeSource(rawStore);
      const { plan, mountDeps } = await resolveReadPlan(rawStore, path, opts?.query, ctx);
      // Deep reads (core-0bl) ride the same runtime: adapters walk descendants
      // inside scanChildren, the projector filters each node independently
      // (flat filter — legacy parity, no subtree pruning). Negatives normalize
      // to -1 so plan identity never aliases (-2 vs -1 are the same scan).
      const depth = opts?.depth ?? 1;
      if (depth !== 1) plan.depth = depth < 0 ? -1 : depth;
      // MVP rule 7: a readable query mount over an unreadable source would
      // act as a capability view (child R-grants leak items the actor can't
      // otherwise list). Gate plan.source before scanning. Non-mount path:
      // plan.source === path, parentPerm above already guarded the same path
      // (an extra resolvePermission walk; the assertion runs on a separate
      // cache, so it pays a second ancestor traversal — accept the cost).
      const actor: Actor = { userId, claims };
      await assertSourceReadable(rawStore, actor, plan.source);
      const project = createProjector(rawStore, actor);

      const reqLimit = Math.min(opts?.limit ?? PUBLIC_LIMIT_DEFAULT, PUBLIC_LIMIT_MAX);

      // Every listing uses the read-runtime cursor contract. `total` describes
      // the returned window; nextCursor is the only "more available" signal.
      const result = await executeList(source, plan, { limit: reqLimit, cursor: opts?.cursor }, project, ctx);
      const page: Page<NodeData> = { items: result.items, total: result.items.length };
      if (result.nextCursor) page.nextCursor = result.nextCursor;
      if (result.truncated) page.truncated = true;
      // Query reads carry their plan to watch registration (Stage 6d) so the
      // initial read and live watch agree on membership.
      if (plan.viewWhere || plan.callerWhere) page.readPlan = { plan, mountDeps };
      return page;
    },

    async set(node, ctx) {
      const wctx = stampActor(ctx);
      const perm = await getPerm(node.$path);
      if (!(perm & W)) throw new OpError('FORBIDDEN', `Access denied: ${node.$path}`);
      const existing = await rawStore.get(node.$path, wctx);
      return rawStore.set(rewriteFullNodeWrite(node, existing, perm, userId, claims), wctx);
    },

    async remove(path, ctx) {
      const wctx = stampActor(ctx);
      const perm = await getPerm(path);
      if (!(perm & W)) throw new OpError('FORBIDDEN', `Access denied: ${path}`);
      return rawStore.remove(path, wctx);
    },

    async patch(path, ops, ctx) {
      const wctx = stampActor(ctx);
      const perm = await getPerm(path);
      // Patch = read-modify-write. R+W gate closes the test-op oracle (no R →
      // no probing via [t, $field, guess]). Per-op checks below cover hidden
      // $-fields, hidden components, and $owner mutation in the same batch.
      if (!((perm & R) && (perm & W))) {
        throw new OpError('FORBIDDEN', `Access denied: ${path}`);
      }

      const existing = await rawStore.get(path, wctx);   // may be undefined
      assertPatchOps(ops, existing, !!(perm & A), userId, claims);

      return rawStore.patch(path, ops, wctx);
    },

    // patchMany: per member, the SAME R+W gate + per-op loop as patch.
    // Set-members take R+W too — a batch is a read-modify-write composite
    // and a $rev-carrying set-member is a rev oracle — while plain set()
    // stays W-only. Set-members are REWRITTEN through the same rules as
    // set() and the safe node is forwarded. All gates run BEFORE the
    // forward, so one forbidden member denies the whole batch with nothing
    // written (the inner adapter is all-or-nothing).
    async patchMany(ancestor, entries, ctx) {
      if (!rawStore.patchMany) {
        throw new OpError('BAD_REQUEST', 'patchMany: store does not support patchMany');
      }
      const wctx = stampActor(ctx);

      const safeEntries: PatchManyEntry[] = [];
      for (const entry of entries) {
        const perm = await getPerm(entry.path);
        if (!((perm & R) && (perm & W))) {
          throw new OpError('FORBIDDEN', `Access denied: ${entry.path}`);
        }
        const existing = await rawStore.get(entry.path, wctx);
        if (isSetEntry(entry)) {
          safeEntries.push({ path: entry.path, node: rewriteFullNodeWrite(entry.node, existing, perm, userId, claims) });
        } else {
          assertPatchOps(entry.ops, existing, !!(perm & A), userId, claims);
          safeEntries.push(entry);
        }
      }

      return rawStore.patchMany(ancestor, safeEntries, wctx);
    },
  };
  return aclStore;
}
