// Treenix Subscriptions — Layer 3
// Wraps any Tree, emits events on set/remove.
// No dependencies beyond Tree + core types.

import { type SubscribeOpts } from '#contexts/service/index';
import { isComponent, isCompKey, type NodeData } from '#core';
import { OpError } from '#errors';
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
import { createSiftTest } from '#tree/query';
import type { ReadPlan } from '#tree/read-runtime';
import { stableJson } from '#util/stable-json';
import fjp from 'fast-json-patch';

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

export type VpDelta = {
  /** Query views whose membership/config/visibility may have shifted —
   *  the caller MUST refetch the listing (coarse dirty, core-gk8.12). */
  invalidateVps?: string[];
};

export type NodeEvent = TreeEvent & Partial<VpDelta>;

/** Pathless coarse-invalidate frame (core-dm1). Born at the ACL filter when a
 *  data event carrying `invalidateVps` must be DROPPED for a reader — they lost
 *  R on the mutated node, or every patch op is ACL-hidden. The watched view
 *  still shifted, so the vp-watcher must refetch. No path, no payload: nothing
 *  for the ACL filter to gate, so it reaches readers who can no longer see the
 *  node that moved — the exact "user losing access leaves stale rows" gap. */
export type InvalidateEvent = { type: 'invalidate'; vps: string[]; seq?: number };

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

// core-anz4.3: query-watch predicates are VALIDATED at registration and
// rejected if they reference a hidden field. membershipVps (below) evaluates
// viewWhere/callerWhere on the write path against ACTOR-PROJECTED,
// storage-shaped nodes (F4) — but projection keeps $acl/$owner for A-holders,
// and mapNodeForSift maps $acl→_acl, $owner→_owner, $refs→_refs
// (tree/index.ts toStorageKeys), so a predicate over $acl/$owner/$refs (or
// their storage aliases _acl/_owner/_refs) stays statically rejected. Fail
// closed on those and on any other unknown $-field; keeps executeList parity
// (core-fnv), and viewWhere is guarded too (NOT trusted: a mount can be
// user-authored). Visible system fields, plain data fields, and #-component
// predicates are allowed — a #-component the actor cannot read is stripped
// by projection before evaluation, so it can never gate their membership.
// Both namespaces are allowlists, not denylists: toStorageKeys maps EVERY
// top-level $foo→_foo, so any unknown _-field (e.g. _v for $v, _secret for a
// hidden $secret) is a storage alias for a hidden system field and must fail
// closed too — enumerating only _acl/_owner/_refs would leak the rest.
const VISIBLE_SYSTEM_FIELDS = new Set(['$path', '$type', '$rev', '$id', '$ref', '$refId']);
const VISIBLE_STORAGE_FIELDS = new Set(['_path', '_type', '_rev', '_tid', '_ref', '_refId']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

/** Throw FORBIDDEN if a sift predicate references a hidden field (system field
 *  or its storage alias). Walks $and/$or/$nor branches; checks the head segment
 *  of dotted paths. Value-level operators ($exists/$gt/…) live under a field key
 *  and are not re-examined. */
function assertVisiblePredicate(q: unknown, where: 'callerWhere' | 'viewWhere'): void {
  if (!q || typeof q !== 'object' || q.constructor !== Object) return;
  for (const [k, v] of Object.entries(q)) {
    if (LOGICAL_OPS.has(k)) {
      const branches = Array.isArray(v) ? v : [v];
      for (const b of branches) assertVisiblePredicate(b, where);
      continue;
    }
    const head = k.split('.')[0];
    const hiddenSystem = head.startsWith('$') && !VISIBLE_SYSTEM_FIELDS.has(head);
    const hiddenStorage = head.startsWith('_') && !VISIBLE_STORAGE_FIELDS.has(head);
    if (hiddenSystem || hiddenStorage) {
      throw new OpError('FORBIDDEN', `${where} references a hidden field: ${k}`);
    }
  }
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
  test: (node: Record<string, unknown>) => boolean;
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
  group: WatchGroup;
};

/** One registration = the SAME plan the initial read ran (read-runtime-mvp:
 *  "initial read and query watch use the same plan"). */
export type QueryWatchRegistration = {
  vp: string;
  userId: string;
  plan: ReadPlan;
  mountDeps: ReadonlySet<string>;
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
  watchQuery(reg: QueryWatchRegistration): void;
  unwatchQuery(vp: string, userId: string): void;
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
  const exactListeners = new Map<string, Set<Listener>>();
  const prefixListeners = new Map<string, Set<Listener>>();
  const selfWriteListeners = new Set<SelfWriteListener>();
  const groups = new Map<string, WatchGroup>();          // planHash → group
  const handleByKey = new Map<string, QueryHandle>();    // userId\0vp → handle
  const handleKey = (userId: string, vp: string) => `${userId}\u0000${vp}`;
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
    // Listener fan-out runs lock-detached (core-anz4.4): dispatch fires inside
    // the emitting write's lock span, and listener-spawned async work must
    // queue like any independent writer, not inherit ownership.
    detachLocks(() => {
      if (event.type !== 'reconnect') {
        const exact = exactListeners.get(event.path);
        if (exact) for (const fn of exact) fn(event);
        for (const [prefix, subs] of prefixListeners) {
          if (event.path === prefix || event.path.startsWith(prefix === '/' ? '/' : prefix + '/')) {
            for (const fn of subs) fn(event);
          }
        }
      }
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

  /** Membership test for a direct child of a query source — evaluated per
   *  SUBSCRIBING ACTOR against the ACL-projected node pair (F4, core-anz4.3).
   *  Raw-node eval was a blind oracle: a predicate gated on data the watcher
   *  cannot read (ACL-stripped component, R-denied node) flipped their
   *  membership, so enter/leave dirty TIMING leaked hidden values — the same
   *  channel executeList closes with FORBIDDEN (core-fnv). Projection runs
   *  once per distinct userId per commit and is shared across groups;
   *  in-folder updates of unchanged membership still ride the ordinary path
   *  event (items are exact-watched). A failed projection over-invalidates
   *  that user's handles (uncorrelated with hidden data; the refetch
   *  re-derives truth through the ACL read path) — raw eval is never a
   *  fallback. */
  async function membershipVps(path: string, oldNode: NodeData | null, newNode: NodeData | null): Promise<string[]> {
    if (groups.size === 0) return [];
    const matching: WatchGroup[] = [];
    for (const g of groups.values()) {
      const prefix = g.source === '/' ? '/' : g.source + '/';
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) matching.push(g);
    }
    if (matching.length === 0) return [];

    const project = projectMembership;
    // Unreachable via watchQuery (registration fails closed without a
    // projector) — kept loud against future registration bypasses.
    if (!project) throw new Error('membershipVps: query watches active without projectMembership');

    type SiftPair = { o: Record<string, unknown> | null; n: Record<string, unknown> | null };
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

    const vps: string[] = [];
    for (const g of matching) {
      for (const h of g.handles) {
        const pair = await projectFor(h.userId);
        if (pair === 'error') { vps.push(h.vp); continue; }
        const wasIn = pair.o ? g.test(pair.o) : false;
        const isIn = pair.n ? g.test(pair.n) : false;
        if (wasIn !== isIn) vps.push(h.vp);
      }
    }
    return vps;
  }

  /** Union the dirty sources; undefined when nothing is dirty. */
  function dirtyVps(...lists: string[][]): { invalidateVps: string[] } | undefined {
    const set = new Set<string>();
    for (const l of lists) for (const vp of l) set.add(vp);
    return set.size ? { invalidateVps: [...set] } : undefined;
  }

  /** Internal subscribe — shared between cdc.subscribe() and watch(). Returns
   *  unregister. `children:true` uses prefixListeners (event.path === prefix
   *  OR starts with prefix + '/'). */
  function internalSubscribe(path: string, listener: Listener, opts?: { children?: boolean }): () => void {
    const map = opts?.children ? prefixListeners : exactListeners;
    if (!map.has(path)) map.set(path, new Set());
    map.get(path)!.add(listener);
    return () => {
      const subs = map.get(path);
      if (subs) {
        subs.delete(listener);
        if (subs.size === 0) map.delete(path);
      }
    };
  }

  function isDirectChild(parent: string, candidate: string): boolean {
    const prefix = parent === '/' ? '/' : parent + '/';
    if (!candidate.startsWith(prefix)) return false;
    const rest = candidate.slice(prefix.length);
    return rest.length > 0 && !rest.includes('/');
  }

  function watch(scope: TreeWatchScope, opts?: TreeWatchOpts, _ctx?: unknown): AsyncIterable<NodeEvent> {
    const reconnectOverflow: NodeEvent = { type: 'reconnect', preserved: false };
    return subscriptionToAsyncIterable<NodeEvent>(
      (push) => {
        if (scope.kind === 'path') {
          return internalSubscribe(scope.path, (event) => push(event));
        }
        if (scope.kind === 'children') {
          // prefixListeners fires on parent + every descendant; we yield
          // only direct children, dropping the parent and grandchildren.
          return internalSubscribe(scope.path, (event) => {
            if (event.type === 'reconnect') { push(event); return; }
            if (isDirectChild(scope.path, event.path)) push(event);
          }, { children: true });
        }
        // 'all' — subscribe to root prefix; every path matches.
        return internalSubscribe('/', (event) => push(event), { children: true });
      },
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
   *  same over-approximation external writes get (vpsForExternalPath) and the
   *  event carries the authority's post-image (one remote read — the only
   *  read left on this path; the wire-ack upgrade in core-anz4.13 deletes it). */
  async function emitOpaque(verb: 'set' | 'patch' | 'remove', path: string, ops: readonly PatchOp[] | undefined, ctx: unknown): Promise<void> {
    const cdc = dirtyVps(vpsForExternalPath(path));
    const by = opIdOf(ctx);
    if (verb === 'remove') {
      emit({ type: 'remove', path, ...(by ? { by } : {}), ...cdc });
      return;
    }
    const stored = await tree.get(path, ctx);
    // Gone already = a concurrent remote remove won; its own event supersedes
    // ours, and a fabricated payload would carry a stale rev (cnr.5 class).
    if (!stored) return;
    if (verb === 'patch' && ops) {
      const mutations = ops.filter(o => o[0] !== 't');
      if (mutations.length === 0) return;
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
      return internalSubscribe(path, listener, opts);
    },

    watchQuery(reg) {
      // core-anz4.15: membershipVps dirties DIRECT children of plan.source
      // only — a depth>1 (or -1 = all descendants) watch silently misses
      // mutations at deeper levels. executeList READ walks descendants, the
      // watch does not; refuse registration until deep membership lands.
      if ((reg.plan.depth ?? 1) !== 1) {
        throw new OpError('BAD_REQUEST', `query watch supports depth 1 only, got ${reg.plan.depth}`);
      }
      // core-anz4.3: validate both predicates — reject hidden fields the
      // projector strips, matching the oracle executeList closes with
      // FORBIDDEN (core-fnv). viewWhere is guarded too (NOT trusted at HEAD: a
      // mount can be user-authored until F4).
      if (reg.plan.callerWhere) assertVisiblePredicate(reg.plan.callerWhere, 'callerWhere');
      if (reg.plan.viewWhere) assertVisiblePredicate(reg.plan.viewWhere, 'viewWhere');
      // F4 fail closed (core-anz4.3): membership must evaluate on the actor's
      // projection; raw-node eval re-opens the hidden-field oracle. No
      // projector configured = no query watch.
      if (!projectMembership) {
        throw new OpError('FORBIDDEN', 'query watch requires a membership projector (SubscriptionOpts.projectMembership)');
      }
      const key = handleKey(reg.userId, reg.vp);
      const hash = planHash(reg.plan);
      const existing = handleByKey.get(key);
      if (existing) {
        if (existing.group.planHash === hash) {
          // Same plan re-registered (page refetch) — refresh deps only.
          (existing as { mountDeps: ReadonlySet<string> }).mountDeps = reg.mountDeps;
          return;
        }
        removeHandle(existing);   // E03: vp re-registered with a different plan
      }

      let group = groups.get(hash);
      if (!group) {
        const viewTest = reg.plan.viewWhere ? createSiftTest(reg.plan.viewWhere) : null;
        const callerTest = reg.plan.callerWhere ? createSiftTest(reg.plan.callerWhere) : null;
        group = {
          planHash: hash,
          source: reg.plan.source,
          test: (n) => (!viewTest || viewTest(n)) && (!callerTest || callerTest(n)),
          handles: new Set(),
        };
        groups.set(hash, group);
      }
      const handle: QueryHandle = { vp: reg.vp, userId: reg.userId, mountDeps: reg.mountDeps, group };
      group.handles.add(handle);
      handleByKey.set(key, handle);
    },

    unwatchQuery(vp, userId) {
      const handle = handleByKey.get(handleKey(userId, vp));
      if (handle) removeHandle(handle);
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
    handleByKey.delete(handleKey(handle.userId, handle.vp));
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
    const inv = dirtyVps(vpsForExternalPath(event.path));
    dispatch(cleanEvent({ ...event, ...inv } as DataEvent));
  }

  return { tree: wrappedTree, cdc, onSelfWrite, injectExternalEvent };
}
