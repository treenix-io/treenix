// Treenix Subscriptions — Layer 3
// Wraps any Tree, emits events on set/remove.
// No dependencies beyond Tree + core types.

import { type SubscribeOpts } from '#contexts/service/index';
import { isComponent, isCompKey, type NodeData } from '#core';
import { KernelError } from '#errors';
import { createSiftTest } from '#kernel/expr';
import { type ExprWork, exprWork } from '#kernel/eval';
import { DEFAULT_LIMITS } from '#kernel/types';
import {
  isSetEntry,
  mapNodeForSift,
  type PatchManyEntry,
  type PatchOp,
  subscriptionToAsyncIterable,
  type Tree,
  type TreeEvent,
  type TreeWatchOpts,
  type TreeWatchScope,
} from '#tree';
import { planHash } from '#tree/plan-hash';
import { assertPlanPredicates, type ReadPlan } from '#tree/read-runtime';
import { stableJson } from '#util/stable-json';
import fjp from 'fast-json-patch';
import { createPathNotifier } from './notifier';

const { compare } = fjp;

/** Diff two nodes via fast-json-patch and convert to compact PatchOp tuples.
 *  fjp is the only consumer of `fast-json-patch` in #sub — its compare()
 *  produces only add/replace/remove (no move/copy/test), so this mapper
 *  exhaustively handles every op it can emit. */
function diffNodes(oldNode: NodeData, newNode: NodeData): PatchOp[] {
  const ops = compare(oldNode, newNode);
  return ops.map((op): PatchOp => {
    const path = op.path.slice(1).replace(/\//g, '.');
    switch (op.op) {
      case 'add':     return ['a', path, (op as { value: unknown }).value];
      case 'replace': return ['r', path, (op as { value: unknown }).value];
      case 'remove':  return ['d', path];
      default:
        throw new Error(`diffNodes: unexpected op from fast-json-patch.compare: ${op.op}`);
    }
  });
}

// ── Event types ──
//
// Layer split:
//   - TreeEvent  (L1, in #tree) — the protocol event. No CDC/VP fields.
//   - NodeEvent  (L3, here)     — TreeEvent extended with the dirty signal.
//
// core-gk8.12: per-user VP prediction (addVps/rmVps/notifyVps + CDC_ROUTES)
// is gone. One coarse signal remains — invalidateVps: "these query views may
// have shifted, refetch through the canonical ACL read path". A wrong refetch
// is impossible; a wrong predicted patch silently corrupts the client cache.

/** vp → userIds whose OWN projection flipped (anz4.27). */
export type MembershipAudience = ReadonlyMap<string, ReadonlySet<string>>;

export type VpDelta = {
  /** Query views whose membership/config/visibility may have shifted —
   *  the caller MUST refetch the listing (coarse dirty, core-gk8.12). */
  invalidateVps?: string[];
  /** anz4.27: audience of membership-sourced vps. Routing-internal — gates vp
   *  delivery, stripped before stamping (never rings, never wires). Coarse vps
   *  (Acl/Config/Claims) have no entry: broadcast (owner-approved §6.3). */
  membershipAudience?: MembershipAudience;
};

export type NodeEvent = TreeEvent & Partial<VpDelta>;

/** Shared holder for legacy/anonymous query registrations (no `holder` on the
 *  reg): mirrors the WatchManager LEGACY_TOKEN — such handles die only via
 *  outright kill (registration death / hash-scoped release), never via a real
 *  token's holder-scoped release. */
const SHARED_HOLDER = '';

/** Pathless coarse-invalidate frame (core-dm1). Born at the ACL filter when a
 *  data event carrying `invalidateVps` must be DROPPED for a reader — they lost
 *  R on the mutated node, or every patch op is ACL-hidden. The watched view
 *  still shifted, so the vp-watcher must refetch. No path, no payload: nothing
 *  for the ACL filter to gate, so it reaches readers who can no longer see the
 *  node that moved — the exact "user losing access leaves stale rows" gap.
 *  `vps` is ALWAYS present (min `[]`) — old clients iterate it unconditionally.
 *  Additive fields (owner-approved §6): `paths` = THIS recipient's own
 *  dropped-payload registrations (inv.16/26 — a vp-only recipient never learns
 *  the hidden source path); `epoch` = stream epoch (anz4.28e — a signal-only
 *  client's resume cursor fails closed without it). */
export type InvalidateEvent = { type: 'invalidate'; vps: string[]; paths?: string[]; seq?: number; epoch?: string };

/** What can travel the event lane to a client: a CDC NodeEvent or a pathless
 *  invalidate. NodeEvent stays free of the wire-only variant so L3 routing
 *  (dispatch/notify) keeps its data-event typing with no narrowing friction. */
export type WireEvent = NodeEvent | InvalidateEvent;

/** Tree narrowed to require `watch` and produce richer NodeEvent (with VPs).
 *  Returned by withSubscriptions so L3 callers consume VPs through the type. */
export type SubscribedTree = Tree & {
  watch(scope: TreeWatchScope, opts?: TreeWatchOpts, ctx?: unknown): AsyncIterable<NodeEvent>;
};

// Strip an empty dirty array — events carry invalidateVps only when real.
function cleanEvent<T extends NodeEvent>(event: T): T {
  const e = { ...event };
  if ('invalidateVps' in e && e.invalidateVps && e.invalidateVps.length === 0) delete e.invalidateVps;
  return e;
}

// ── ACL/config mutation detection ──
// Stage-6 invalidation gate: ACL or config changes can shift query
// membership in ways the exact-diff path can't reliably reconstruct
// (e.g. $acl change makes a previously-hidden node visible to a watcher).
// Detect here so callers can route an `invalidateVps` to affected queries.

function isAclChange(oldNode: NodeData | null, newNode: NodeData | null): boolean {
  // $acl array or $owner string differ → ACL change. Stable stringify since
  // arrays may serialise different orderings of the same logical content.
  const oldAcl = oldNode?.$acl;
  const newAcl = newNode?.$acl;
  const oldOwner = oldNode?.$owner;
  const newOwner = newNode?.$owner;
  if (oldOwner !== newOwner) return true;
  if (!oldAcl && !newAcl) return false;
  return JSON.stringify(oldAcl) !== JSON.stringify(newAcl);
}

function isAclOp(op: PatchOp): boolean {
  // Any op touching $acl or $owner — including nested paths like $acl.0.p.
  const path = op[1];
  return path === '$acl' || path === '$owner'
    || path.startsWith('$acl.') || path.startsWith('$owner.');
}


export type Listener = (event: NodeEvent) => void;

/** Extract the client mutation id from a write ctx (core-gk8.1). Writers opt
 *  in by passing `{ opId }` as the Tree ctx; resulting events echo it as `by`. */
function opIdOf(ctx: unknown): string | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const v = (ctx as Record<string, unknown>).opId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── CDC Registry (instance-scoped) ──
// Stage 6d (core-9yd): two-level model. A WatchGroup owns ONE compiled
// membership test per unique plan (keyed by planHash — vp is presentation,
// not identity; N view paths over the same plan share one evaluation). A
// QueryHandle is one (userId, vp) registration: it carries mountDeps for
// targeted config invalidation and dies independently of its group.
// Membership evaluation is per-ACTOR on the projected node (F4, core-anz4.3):
// the dirty signal still carries no data — visibility re-derives on the ACL'd
// refetch — but a flip is signalled only to subscribers whose OWN projection
// changed, so hidden fields cannot drive their membership timing.

type WatchGroup = {
  planHash: string;
  source: string;
  /** Combined viewWhere ∧ callerWhere test — callerWhere participating is
   *  the 6d fix: a watch registered without it silently missed flips on
   *  caller-filtered views (core-92z guard, now lifted). */
  test: (node: Record<string, unknown>, work: ExprWork) => boolean;
  handles: Set<QueryHandle>;
};

type QueryHandle = {
  vp: string;
  /** Drives claims-change targeting, lifecycle, and actor projection (F4).
   *  No claims stored here — projectMembership resolves them at eval time. */
  userId: string;
  /** Mount/config paths consulted by resolveReadPlan. Contract: contains at
   *  least the vp itself — config-change targeting relies on it. */
  mountDeps: ReadonlySet<string>;
  /** Kept verbatim so a replace hands the PREVIOUS registration back for
   *  lease-undo restore (inv.15) — the compiled test cannot reconstruct it. */
  plan: ReadPlan;
  group: WatchGroup;
  /** Holder tokens, same shape as WatchManager path holders (§4.2 F5): the
   *  handle dies with its LAST holder — a released token's plan must not stay
   *  live behind a co-holder, and a co-holder's release must not nuke plans
   *  it never registered. */
  holders: Set<string>;
};

/** One registration = the SAME plan the initial read ran (read-runtime-mvp:
 *  "initial read and query watch use the same plan"). */
export type QueryWatchRegistration = {
  vp: string;
  userId: string;
  plan: ReadPlan;
  mountDeps: ReadonlySet<string>;
  /** Watch-ownership token of the registering lease (§4.2 F5). Absent =
   *  legacy/anonymous: seeds the shared holder on create, touches no holders
   *  on refresh (the lease-undo deps-restore path relies on that). */
  holder?: string;
};

/** Project one commit's (old, new) node pair as `userId` may read it — null
 *  means the user cannot read the node at all (executeList's Projector
 *  contract). Injected from the composition root: security owns projection,
 *  sub/ stays auth-ignorant. */
export type MembershipProjector = (
  userId: string,
  oldNode: NodeData | null,
  newNode: NodeData | null,
) => Promise<readonly [NodeData | null, NodeData | null]>;

export type CdcRegistry = {
  subscribe(path: string, listener: Listener, opts?: SubscribeOpts): () => void;
  /** Handle key = (userId, vp, planHash) — different plans on one vp COEXIST
   *  (E03 → coexistence, §4.2). Returns the prior SAME-plan registration
   *  (deps refresh; null = new handle) for lease-undo restore (inv.15), plus
   *  whether `reg.holder` was newly added — undo must strip exactly that (F5). */
  watchQuery(reg: QueryWatchRegistration): { prev: QueryWatchRegistration | null; holderAdded: boolean };
  /** With `holder`: release that token's hold — the handle dies only when its
   *  holders empty (F5; scoped by `planHash` when given, else every plan of
   *  the vp). Without `holder`: outright kill — lease-scoped when `planHash`
   *  given, else registration death for every plan of (userId, vp) (a
   *  watcherless plan is a leak). */
  unwatchQuery(vp: string, userId: string, planHash?: string, holder?: string): void;
  unwatchAllQueries(userId: string): void;
  /** Distinct execution groups (deduped plans), not registrations. */
  getActiveQueryCount(): number;
};

/** Layer-injected detectors (core-gk8.12) — sub/ stays ignorant of the auth
 *  layout and of mount components; the server layer wires the real ones.
 *  Absent detector = that invalidation trigger is off (liveness, not access
 *  control — reads stay ACL-filtered regardless). */
export type SubscriptionOpts = {
  /** Map a written path to the userId whose claims it defines (e.g. /auth/users/X). */
  claimsUserOf?: (path: string) => string | null;
  /** True when the node carries mount/config that steers reads on its vp. */
  isConfigNode?: (node: NodeData | null | undefined) => boolean;
  /** True when a component of this type declares a type-level `acl` rule
   *  (`register(type, 'acl', …)`). Lets sub/ detect permission-bearing
   *  components without importing the registry. Absent = type-level rules
   *  off; inline `component.$acl` is still detected structurally. */
  componentHasAclRule?: (type: string) => boolean;
  /** F4 actor-projected membership (core-anz4.3). Unlike the detectors above
   *  this is ACCESS CONTROL, not liveness: absent projector = query watches
   *  are REFUSED at registration (fail closed) — raw-node membership eval
   *  would leak hidden fields via enter/leave dirty timing. */
  projectMembership?: MembershipProjector;
  /** Run listener fan-out with a CLEARED mutation-lock held-set (core-anz4.4).
   *  Dispatch fires synchronously inside the commit envelope's lock span;
   *  listeners spawn async work that inherits lock ownership via ALS and would
   *  falsely re-enter the emitting write's lock. Injected from the composition
   *  root (the server owns the lock; sub/ stays layer-ignorant). */
  detachLocks?: <T>(fn: () => T) => T;
};

/** Self-write notification — fired for every data event emitted by
 *  withSubscriptions. Consumed by runExternalWatch dedup buffers so an
 *  external watch source (Mongo change stream, etc.) can recognize and
 *  skip events it observes as a side-effect of in-pipeline writes. */
export type SelfWriteListener = (path: string, rev: number | undefined) => void;
export type OnSelfWrite = (listener: SelfWriteListener) => () => void;

export function withSubscriptions(
  tree: Tree,
  onEvent?: (event: NodeEvent) => void,
  opts?: SubscriptionOpts,
): { tree: SubscribedTree; cdc: CdcRegistry; onSelfWrite: OnSelfWrite; injectExternalEvent: (event: TreeEvent) => void } {
  const notifier = createPathNotifier<NodeEvent>();
  const selfWriteListeners = new Set<SelfWriteListener>();
  const groups = new Map<string, WatchGroup>();          // planHash → group
  const handleByKey = new Map<string, QueryHandle>();    // userId\0vp\0planHash → handle (§4.2 coexistence)
  const handleKey = (userId: string, vp: string, hash: string) => `${userId}\u0000${vp}\u0000${hash}`;
  const claimsUserOf = opts?.claimsUserOf ?? (() => null);
  const isConfigNode = opts?.isConfigNode ?? (() => false);
  const detachLocks: NonNullable<SubscriptionOpts['detachLocks']> = opts?.detachLocks ?? (fn => fn());
  const componentHasAclRule = opts?.componentHasAclRule ?? (() => false);
  const projectMembership = opts?.projectMembership;

  /** A component is permission-bearing when it carries an inline `$acl` OR its
   *  type declares an `acl` rule — mirrors componentPerm's evaluation order. */
  function isPermissionBearing(comp: unknown): boolean {
    if (!isComponent(comp)) return false;
    return !!comp.$acl || componentHasAclRule(comp.$type);
  }

  /** MVP-spec ACL-affecting rule (docs/…/read-runtime-mvp.md §"ACL-affecting"):
   *  a mutation touching a component that declares a permission rule shifts
   *  projection just like a `$acl`/`$owner` change. True when a permission-
   *  bearing component was added, removed, gained/lost its rule, or changed
   *  content — the exact-diff path can't reconstruct the visibility flip. */
  function isComponentAclChange(oldNode: NodeData | null, newNode: NodeData | null): boolean {
    const keys = new Set<string>();
    for (const k in oldNode) if (isCompKey(k)) keys.add(k);
    for (const k in newNode) if (isCompKey(k)) keys.add(k);
    for (const k of keys) {
      const o = oldNode?.[k];
      const n = newNode?.[k];
      const oBearing = isPermissionBearing(o);
      const nBearing = isPermissionBearing(n);
      if (!oBearing && !nBearing) continue;
      if (oBearing !== nBearing) return true;
      if (stableJson(o) !== stableJson(n)) return true;
    }
    return false;
  }

  function notifySelfWrite(event: DataEvent) {
    if (selfWriteListeners.size === 0) return;
    const rev = event.type === 'patch'
      ? event.rev
      : event.type === 'set'
        ? (event.node as { $rev?: number }).$rev
        : undefined;
    for (const l of selfWriteListeners) {
      try { l(event.path, rev); }
      catch (err) { console.error('[withSubscriptions] selfWrite listener threw:', err); }
    }
  }

  type DataEvent = Exclude<NodeEvent, { type: 'reconnect' }>;

  function dispatch(event: NodeEvent) {
    // Lock-detached fan-out (core-anz4.4): listener-spawned async work must
    // queue like an independent writer, not inherit the emitting write's lock.
    detachLocks(() => {
      if (event.type !== 'reconnect') notifier.notify(event.path, event);
      onEvent?.(event);
    });
  }

  function emit(raw: DataEvent) {
    const event = cleanEvent(raw);
    // notifySelfWrite MUST run before dispatch — external-watch dedup buffers
    // populate from this callback and could otherwise race the change-stream echo.
    notifySelfWrite(event);
    dispatch(event);
  }

  function groupVps(g: WatchGroup, out: string[]): void {
    for (const h of g.handles) out.push(h.vp);
  }

  /** Compute invalidate-vp set for a mount/config write. Targets handles
   *  whose `mountDeps` contain the mutated path — the mount/config node
   *  steering their plan was rewritten (6d: replaces `q.vp === path`; deps
   *  always include the vp itself). Per MVP: targeted, not a global storm. */
  function vpsForConfigChange(path: string): string[] {
    const vps: string[] = [];
    for (const h of handleByKey.values()) if (h.mountDeps.has(path)) vps.push(h.vp);
    return vps;
  }

  /** Invalidate every active query whose source could be affected by an
   *  external write at `path`. Match cases:
   *    1. path === source                  — direct change of source node
   *    2. path is a direct child of source — normal vp membership rule
   *    3. path is an ANCESTOR of source    — ACL/config change up the tree
   *    4. path ∈ handle.mountDeps          — a plan-steering node (the vp
   *       mount itself, or any consulted config) was rewritten
   *  Grand-descendants are skipped (can't affect direct-child queries). */
  function vpsForExternalPath(path: string): string[] {
    const vps: string[] = [];
    for (const g of groups.values()) {
      const prefix = g.source === '/' ? '/' : g.source + '/';
      const directChild = path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
      const isSource = path === g.source;
      const isAncestor = path === '/' || (g.source !== '/' && g.source.startsWith(path + '/'));
      if (directChild || isSource || isAncestor) groupVps(g, vps);
    }
    for (const h of handleByKey.values()) if (h.mountDeps.has(path)) vps.push(h.vp);
    return vps;
  }

  /** Claims change for `userId` → every query this user subscribes to goes
   *  dirty. The invalidate is a broadcast field — co-watchers of the same vp
   *  over-refetch; bounded and rare (claims changes), accepted (gk8.12). */
  function vpsForClaimsChange(userId: string): string[] {
    const vps: string[] = [];
    for (const h of handleByKey.values()) if (h.userId === userId) vps.push(h.vp);
    return vps;
  }

  /** ACL change at `path` → dirty every query view it can affect. ACL
   *  inherits DOWN the tree, so the affected set is:
   *    1. P is at-or-above source (source ∈ {P, descendants of P})
   *    2. P is a direct child of source (P's ACL was the membership gate)
   *  User-independent and sync (gk8.12): the old per-user R-filter was a
   *  second ACL decision path on the write path. Deliberate over-invalidation
   *  — the refetch re-derives truth through the canonical ACL read path, and
   *  the dirty signal names only the vp the subscriber already watches. */
  function vpsForAclChange(path: string): string[] {
    if (groups.size === 0) return [];

    function isAtOrAbove(p: string, candidate: string): boolean {
      if (p === '/' || p === candidate) return true;
      return candidate.startsWith(p + '/');
    }
    function isDirectChildOf(parent: string, candidate: string): boolean {
      const prefix = parent === '/' ? '/' : parent + '/';
      if (!candidate.startsWith(prefix)) return false;
      const rest = candidate.slice(prefix.length);
      return rest.length > 0 && !rest.includes('/');
    }

    const vps: string[] = [];
    for (const g of groups.values()) {
      if (isAtOrAbove(path, g.source) || isDirectChildOf(g.source, path)) groupVps(g, vps);
    }
    return vps;
  }

  /** Membership flips for a direct child of a query source, evaluated per
   *  SUBSCRIBING ACTOR on the ACL-projected pair (F4, core-anz4.3 — raw eval
   *  was a hidden-field timing oracle; executeList parity core-fnv). Returns
   *  vp → flipped userIds (anz4.27); a flip is per PLAN (§4.2). Projection
   *  runs once per userId per commit, shared across groups; a failed
   *  projection over-invalidates THAT user only — raw eval is never a fallback. */
  type SiftPair = { o: Record<string, unknown> | null; n: Record<string, unknown> | null };

  /** One subscription updated by one write is one operation: the old and new node share its work counter. Past
   *  the limit the update ends the subscription — the write is already committed. This protocol has no
   *  per-subscription end, so the handle is unregistered and its subscriber is told to refetch: the read runs
   *  the plan anew and refuses it while the work is over the limit. */
  function membershipFlipped(h: QueryHandle, pair: SiftPair, path: string): boolean {
    const work = exprWork(DEFAULT_LIMITS);
    try {
      return (pair.o ? h.group.test(pair.o, work) : false) !== (pair.n ? h.group.test(pair.n, work) : false);
    } catch (err) {
      if (!(err instanceof KernelError) || err.code !== 'BUDGET') throw err;
      console.error('[withSubscriptions] query watch %s of user=%s ended: the update by %s is over the work limit:', h.vp, h.userId, path, err);
      removeHandle(h);
      return true;
    }
  }

  async function membershipVps(path: string, oldNode: NodeData | null, newNode: NodeData | null): Promise<Map<string, Set<string>>> {
    const flips = new Map<string, Set<string>>();
    if (groups.size === 0) return flips;
    const matching: WatchGroup[] = [];
    for (const g of groups.values()) {
      const prefix = g.source === '/' ? '/' : g.source + '/';
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) matching.push(g);
    }
    if (matching.length === 0) return flips;

    const project = projectMembership;
    // Unreachable via watchQuery (registration fails closed without a
    // projector) — kept loud against future registration bypasses.
    if (!project) throw new Error('membershipVps: query watches active without projectMembership');

    const perUser = new Map<string, Promise<SiftPair | 'error'>>();
    const projectFor = (userId: string) => {
      let p = perUser.get(userId);
      if (!p) {
        p = project(userId, oldNode, newNode).then(
          ([o, n]): SiftPair => ({ o: o && mapNodeForSift(o), n: n && mapNodeForSift(n) }),
          (err): 'error' => {
            console.error('[withSubscriptions] membership projection failed for user=%s path=%s:', userId, path, err);
            return 'error';
          },
        );
        perUser.set(userId, p);
      }
      return p;
    };

    // Start every subscriber's projection before awaiting any: this runs inside
    // the writer's lock span, so sequential awaits cost U × (claims + ancestor
    // walk) per write; concurrent ones cost the slowest.
    for (const g of matching) for (const h of g.handles) projectFor(h.userId);

    for (const g of matching) {
      for (const h of g.handles) {
        const pair = await projectFor(h.userId);
        const flipped = pair === 'error' || membershipFlipped(h, pair, path);
        if (!flipped) continue;
        let uids = flips.get(h.vp);
        if (!uids) flips.set(h.vp, uids = new Set());
        uids.add(h.userId);
      }
    }
    return flips;
  }

  type DirtyCdc = { invalidateVps: string[]; membershipAudience?: MembershipAudience } | undefined;

  /** Union the dirty sources; undefined when nothing is dirty. Membership vps
   *  carry their audience UNLESS a coarse source also names the vp — coarse
   *  stays user-independent broadcast (owner-approved §6.3). */
  function dirtyVps(membership: Map<string, Set<string>> | null, ...coarse: string[][]): DirtyCdc {
    const set = new Set<string>();
    if (membership) for (const vp of membership.keys()) set.add(vp);
    for (const l of coarse) for (const vp of l) set.add(vp);
    if (set.size === 0) return undefined;

    let audience: Map<string, Set<string>> | undefined;
    if (membership && membership.size > 0) {
      const broadcast = new Set(coarse.flat());
      for (const [vp, uids] of membership) {
        if (broadcast.has(vp)) continue;
        (audience ??= new Map()).set(vp, uids);
      }
    }
    return { invalidateVps: [...set], ...(audience ? { membershipAudience: audience } : {}) };
  }

  /** Thin adapter over the PathNotifier (invariant 20): path → exact,
   *  children → direct-only, all → subtree at root. */
  function watch(scope: TreeWatchScope, opts?: TreeWatchOpts, _ctx?: unknown): AsyncIterable<NodeEvent> {
    const reconnectOverflow: NodeEvent = { type: 'reconnect', preserved: false };
    return subscriptionToAsyncIterable<NodeEvent>(
      (push) => scope.kind === 'path' ? notifier.register(scope.path, 'exact', push)
        : scope.kind === 'children' ? notifier.register(scope.path, 'children', push)
        : notifier.register('/', 'subtree', push),
      reconnectOverflow,
      opts,
    );
  }

  const wrappedTree: SubscribedTree = {
    get: tree.get.bind(tree),
    getChildren: tree.getChildren.bind(tree),
    // Forward only when inner exposes it; sub/ never enriches scans.
    ...(tree.scanChildren ? { scanChildren: tree.scanChildren.bind(tree) } : {}),
    watch,

    // Events derive from the CommitReceipt (core-ns6p.2): before/after images
    // come from the adapter's atomic span, so the pre/post rereads — and the
    // coherency window where a second write could poison them — are gone.
    async set(node, ctx) {
      // Defense in depth: strip string $patches if injected
      if ('$patches' in node) {
        node = { ...node };
        delete node['$patches'];
      }

      const receipt = await tree.set(node, ctx);
      if (receipt.changes === null) {
        await emitOpaque('set', node.$path, undefined, ctx);
        return receipt;
      }
      const c = receipt.changes[0];
      if (!c?.after) throw new Error(`withSubscriptions: set receipt for ${node.$path} missing after image`);
      await emitSetEvent(c.path, c.before ?? undefined, ctx, c.after);
      return receipt;
    },

    async remove(path, ctx) {
      const receipt = await tree.remove(path, ctx);
      if (receipt.changes === null) {
        await emitOpaque('remove', path, undefined, ctx);
        return receipt;
      }
      // Overlay reveal: the remove UNCOVERED a lower node — the view now
      // serves it, so subscribers get a set (emitting remove would make
      // clients delete a node that is still visible).
      const revealed = receipt.changes[0]?.after;
      if (revealed) {
        await emitSetEvent(path, receipt.changes[0].before ?? undefined, ctx, revealed);
        return receipt;
      }
      const oldNode = receipt.changes[0]?.before;
      if (oldNode) {
        const claimsUid = claimsUserOf(path);
        // Remove drops $acl entirely — treat as ACL change so subscribers
        // re-fetch (visibility of siblings whose ACL inheritance chain ran
        // through this node may flip).
        const cdc = dirtyVps(
          await membershipVps(path, oldNode, null),
          (oldNode.$acl || oldNode.$owner || isComponentAclChange(oldNode, null)) ? vpsForAclChange(path) : [],
          isConfigNode(oldNode) ? vpsForConfigChange(path) : [],
          claimsUid ? vpsForClaimsChange(claimsUid) : [],
        );
        const by = opIdOf(ctx);
        emit({ type: 'remove', path, ...(by ? { by } : {}), ...cdc });
      }
      return receipt;
    },

    async patch(path, ops, ctx) {
      const receipt = await tree.patch(path, ops, ctx);
      if (receipt.changes === null) {
        await emitOpaque('patch', path, ops, ctx);
        return receipt;
      }
      const c = receipt.changes[0];
      if (c) await emitPatch(path, ops, c.before ?? undefined, c.after ?? undefined, ctx);
      return receipt;
    },

    // patchMany (core-gk8.15): one event per member, derived from the batch
    // receipt. Emission is strictly AFTER the inner call returns — a failed
    // batch emits nothing.
    ...(tree.patchMany ? {
      async patchMany(ancestor: string, entries: PatchManyEntry[], ctx?: unknown) {
        const receipt = await tree.patchMany!(ancestor, entries, ctx);
        if (receipt.changes === null) {
          for (const e of entries) {
            await emitOpaque(isSetEntry(e) ? 'set' : 'patch', e.path, isSetEntry(e) ? undefined : e.ops, ctx);
          }
          return receipt;
        }

        const byPath = new Map(receipt.changes.map(c => [c.path, c]));
        for (const entry of entries) {
          // Adapters report every member (policy augmentation preserves paths);
          // a missing one is a receipt bug, not a skippable condition.
          const c = byPath.get(entry.path);
          if (!c) throw new Error(`withSubscriptions: patchMany receipt missing member ${entry.path}`);
          if (isSetEntry(entry)) {
            // Set-member = full-node write, may CREATE (gk8.10 stage 2).
            // Routing it through emitPatch with ops=[] would emit NOTHING
            // (mutations-length guard) — the node invisible to subscribers.
            if (!c.after) throw new Error(`withSubscriptions: set-member receipt for ${entry.path} missing after image`);
            await emitSetEvent(entry.path, c.before ?? undefined, ctx, c.after);
          } else {
            await emitPatch(entry.path, entry.ops, c.before ?? undefined, c.after ?? undefined, ctx);
          }
        }
        return receipt;
      },
    } : {}),
  };

  /** Coarse emission for an OPAQUE receipt (remote authority, core-ns6p.2):
   *  no images to diff or evaluate membership on, so the dirty set is the
   *  external-write over-approximation (vpsForExternalPath) PLUS the
   *  image-free detectors (claims by path; config from the post-image). The
   *  event carries the authority's post-image (one remote read — the only
   *  read left on this path; the wire-ack upgrade in core-anz4.13 deletes it). */
  async function emitOpaque(verb: 'set' | 'patch' | 'remove', path: string, ops: readonly PatchOp[] | undefined, ctx: unknown): Promise<void> {
    // Test-only patch: nothing written, nothing to signal (non-opaque parity).
    const mutations = verb === 'patch' && ops ? ops.filter(o => o[0] !== 't') : undefined;
    if (mutations && mutations.length === 0) return;

    const by = opIdOf(ctx);
    const claimsUid = claimsUserOf(path);
    if (verb === 'remove') {
      const cdc = dirtyVps(null, vpsForExternalPath(path), claimsUid ? vpsForClaimsChange(claimsUid) : []);
      emit({ type: 'remove', path, ...(by ? { by } : {}), ...cdc });
      return;
    }

    const stored = await tree.get(path, ctx);
    const cdc = dirtyVps(
      null,
      vpsForExternalPath(path),
      claimsUid ? vpsForClaimsChange(claimsUid) : [],
      isConfigNode(stored) ? vpsForConfigChange(path) : [],
    );
    if (!stored) {
      // A concurrent remote remove won. Reflect the CURRENT state loudly — a
      // silent return would drop both the event and the dirty signal, and a
      // fabricated set payload would carry a stale rev (cnr.5 class).
      emit({ type: 'remove', path, ...(by ? { by } : {}), ...cdc });
      return;
    }
    if (mutations) {
      emit({ type: 'patch', path, patches: mutations, rev: stored.$rev, ...(by ? { by } : {}), ...cdc });
      return;
    }
    const { $path, ...body } = stored;
    emit({ type: 'set', path: $path, node: body, ...(by ? { by } : {}), ...cdc });
  }

  /** CDC dirty computation + event emission for ONE full-node write — shared
   *  by set() and patchMany set-members (after the inner batch commits).
   *  Emits from the receipt's STORED after-image, never the caller's ref —
   *  layers below may copy the node (repath/mount path translation), so the
   *  adapter's in-place $rev bump — and stamped fields ($refs, $v) — never
   *  reach the caller's object. Trusting the input emitted pre-bump revs, so
   *  every subscriber cached a stale $rev → false OCC conflicts (cnr.5 C2). */
  async function emitSetEvent(path: string, oldNode: NodeData | undefined, ctx: unknown, stored: NodeData): Promise<void> {
    const claimsUid = claimsUserOf(path);
    const cdc = dirtyVps(
      await membershipVps(path, oldNode ?? null, stored),
      (isAclChange(oldNode ?? null, stored) || isComponentAclChange(oldNode ?? null, stored)) ? vpsForAclChange(path) : [],
      // Config write: either side carries a mount/config component — the vp
      // node itself is being rewritten, handles on it must re-fetch.
      isConfigNode(oldNode) || isConfigNode(stored) ? vpsForConfigChange(path) : [],
      claimsUid ? vpsForClaimsChange(claimsUid) : [],
    );

    const { $path, ...body } = stored;
    const by = opIdOf(ctx);

    if (oldNode) {
      const computed = diffNodes(oldNode, stored);
      emit(computed.length > 0
        ? { type: 'patch', path: $path, patches: computed, rev: stored.$rev, ...(by ? { by } : {}), ...cdc }
        : { type: 'set', path: $path, node: body, ...(by ? { by } : {}), ...cdc });
    } else {
      emit({ type: 'set', path: $path, node: body, ...(by ? { by } : {}), ...cdc });
    }
  }

  /** CDC dirty computation + event emission for ONE patched path — shared by
   *  patch and patchMany (per member, after the inner batch commits). */
  async function emitPatch(path: string, ops: readonly PatchOp[], oldNode: NodeData | undefined, newNode: NodeData | undefined, ctx: unknown): Promise<void> {
    // Config write detection on patch: either node had/has config, or an op
    // touched the `mount` field directly (covers add/replace of the
    // component on a previously-non-config node).
    const opsTouchedMount = ops.some(op => {
      const p = op[1];
      return p === '#mount' || p.startsWith('#mount.');
    });
    const claimsUid = claimsUserOf(path);
    const cdc = dirtyVps(
      await membershipVps(path, oldNode ?? null, newNode ?? null),
      // Both directions: ops touched $acl/$owner directly OR the resulting
      // diff shows a $acl change (covers full-node replace via patch).
      (ops.some(isAclOp) || isAclChange(oldNode ?? null, newNode ?? null) || isComponentAclChange(oldNode ?? null, newNode ?? null)) ? vpsForAclChange(path) : [],
      (opsTouchedMount || isConfigNode(oldNode) || isConfigNode(newNode)) ? vpsForConfigChange(path) : [],
      claimsUid ? vpsForClaimsChange(claimsUid) : [],
    );

    // Emit only mutation ops (filter out test ops) — same PatchOp shape
    // tree.patch consumes; no RFC 6902 conversion on the wire.
    const mutations = ops.filter(o => o[0] !== 't');
    if (mutations.length > 0) {
      const by = opIdOf(ctx);
      emit({ type: 'patch', path, patches: mutations, rev: newNode?.$rev, ...(by ? { by } : {}), ...cdc });
    }
  }

  const cdc: CdcRegistry = {
    subscribe(path, listener, opts) {
      // CDC "children" = self + every descendant (subtree), unlike the L3
      // watch children scope (direct-only) — invariant 20 keeps both contracts.
      return notifier.register(path, opts?.children ? 'subtree' : 'exact', listener);
    },

    watchQuery(reg) {
      // core-anz4.15: membershipVps dirties DIRECT children of plan.source
      // only — a depth>1 (or -1 = all descendants) watch silently misses
      // mutations at deeper levels. executeList READ walks descendants, the
      // watch does not; refuse registration until deep membership lands.
      if ((reg.plan.depth ?? 1) !== 1) {
        throw new KernelError('INVALID', `query watch supports depth 1 only, got ${reg.plan.depth}`);
      }
      // core-anz4.3: validate both predicates — reject hidden fields the
      // projector strips, matching the oracle executeList closes with
      // FORBIDDEN (core-fnv). viewWhere is guarded too (NOT trusted at HEAD: a
      // mount can be user-authored until F4).
      assertPlanPredicates(reg.plan);
      // F4 fail closed (core-anz4.3): membership must evaluate on the actor's
      // projection; raw-node eval re-opens the hidden-field oracle. No
      // projector configured = no query watch.
      if (!projectMembership) {
        throw new KernelError('FORBIDDEN', 'query watch requires a membership projector (SubscriptionOpts.projectMembership)');
      }
      // E03 → coexistence (§4.2, owner sign-off 2026-07-18): planHash is part of
      // the handle identity — a DIFFERENT plan on the same (userId, vp) coexists.
      const hash = planHash(reg.plan);
      const key = handleKey(reg.userId, reg.vp, hash);
      const existing = handleByKey.get(key);
      if (existing) {
        // Same plan re-registered (page refetch) — refresh deps, add the holder.
        const prev = { vp: existing.vp, userId: existing.userId, plan: existing.plan, mountDeps: existing.mountDeps };
        existing.mountDeps = reg.mountDeps;
        existing.plan = reg.plan;
        const holderAdded = reg.holder !== undefined && !existing.holders.has(reg.holder);
        if (reg.holder !== undefined) existing.holders.add(reg.holder);
        return { prev, holderAdded };
      }

      let group = groups.get(hash);
      if (!group) {
        const viewTest = reg.plan.viewWhere ? createSiftTest(reg.plan.viewWhere, DEFAULT_LIMITS) : null;
        const callerTest = reg.plan.callerWhere ? createSiftTest(reg.plan.callerWhere, DEFAULT_LIMITS) : null;
        group = {
          planHash: hash,
          source: reg.plan.source,
          test: (n, work) => (!viewTest || viewTest(n, work)) && (!callerTest || callerTest(n, work)),
          handles: new Set(),
        };
        groups.set(hash, group);
      }
      const handle: QueryHandle = {
        vp: reg.vp, userId: reg.userId, mountDeps: reg.mountDeps, plan: reg.plan, group,
        holders: new Set([reg.holder ?? SHARED_HOLDER]),
      };
      group.handles.add(handle);
      handleByKey.set(key, handle);
      return { prev: null, holderAdded: true };
    },

    unwatchQuery(vp, userId, hash, holder) {
      for (const handle of [...handleByKey.values()]) {
        if (handle.userId !== userId || handle.vp !== vp) continue;
        if (hash !== undefined && handle.group.planHash !== hash) continue;
        // F5 holder-scoped release: the handle survives on its co-holders.
        if (holder !== undefined && (!handle.holders.delete(holder) || handle.holders.size > 0)) continue;
        removeHandle(handle);
      }
    },

    unwatchAllQueries(userId) {
      for (const handle of [...handleByKey.values()]) {
        if (handle.userId === userId) removeHandle(handle);
      }
    },

    getActiveQueryCount() {
      return groups.size;
    },
  };

  function removeHandle(handle: QueryHandle): void {
    handleByKey.delete(handleKey(handle.userId, handle.vp, handle.group.planHash));
    handle.group.handles.delete(handle);
    if (handle.group.handles.size === 0) groups.delete(handle.group.planHash);
  }

  const onSelfWrite: OnSelfWrite = (listener) => {
    selfWriteListeners.add(listener);
    return () => { selfWriteListeners.delete(listener); };
  };

  /** Ingest a TreeEvent from an external source (Mongo change stream etc.).
   *  Routes through the same dispatch as in-pipeline writes, BUT skips
   *  notifySelfWrite (the event isn't from us). Enriches data events with
   *  `invalidateVps` for any active query whose source could contain the
   *  path — query/VP watchers refetch instead of silently missing the
   *  change. Reconnect events skip CDC and go straight to onEvent. */
  function injectExternalEvent(event: TreeEvent) {
    if (event.type === 'reconnect') {
      dispatch(event);
      return;
    }
    const inv = dirtyVps(null, vpsForExternalPath(event.path));
    dispatch(cleanEvent({ ...event, ...inv } as DataEvent));
  }

  return { tree: wrappedTree, cdc, onSelfWrite, injectExternalEvent };
}
