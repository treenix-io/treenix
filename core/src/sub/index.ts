// Treenix Subscriptions — Layer 3
// Wraps any Tree, emits events on set/remove.
// No dependencies beyond Tree + core types.

import { type SubscribeOpts } from '#contexts/service/index';
import { isComponent, isCompKey, type NodeData } from '#core';
import {
  mapNodeForSift,
  type PatchOp,
  subscriptionToAsyncIterable,
  type Tree,
  type TreeEvent,
  type TreeWatchOpts,
  type TreeWatchScope,
} from '#tree';
import { createSiftTest } from '#tree/query';
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

export type Listener = (event: NodeEvent) => void;

/** Extract the client mutation id from a write ctx (core-gk8.1). Writers opt
 *  in by passing `{ opId }` as the Tree ctx; resulting events echo it as `by`. */
function opIdOf(ctx: unknown): string | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const v = (ctx as Record<string, unknown>).opId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── CDC Registry (instance-scoped) ──

type QueryEntry = {
  vp: string;
  source: string;
  matchKey: string;
  match: Record<string, unknown>;
  test: (node: Record<string, unknown>) => boolean;
  /** Subscribed userIds — drives claims-change targeting and lifecycle only.
   *  No per-user claims here: visibility is decided once, on the read path. */
  users: Set<string>;
};

export type CdcRegistry = {
  subscribe(path: string, listener: Listener, opts?: SubscribeOpts): () => void;
  watchQuery(vp: string, source: string, match: Record<string, unknown>, userId: string): void;
  unwatchQuery(vp: string, userId: string): void;
  unwatchAllQueries(userId: string): void;
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
  const activeQueries: QueryEntry[] = [];
  const claimsUserOf = opts?.claimsUserOf ?? (() => null);
  const isConfigNode = opts?.isConfigNode ?? (() => false);
  const componentHasAclRule = opts?.componentHasAclRule ?? (() => false);

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

  function stableJson(value: unknown): string {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }

  type DataEvent = Exclude<NodeEvent, { type: 'reconnect' }>;

  function dispatch(event: NodeEvent) {
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
  }

  function emit(raw: DataEvent) {
    const event = cleanEvent(raw);
    // notifySelfWrite MUST run before dispatch — external-watch dedup buffers
    // populate from this callback and could otherwise race the change-stream echo.
    notifySelfWrite(event);
    dispatch(event);
  }

  /** Compute invalidate-vp set for a mount/config write. Targets handles
   *  whose vp IS the mutated path — the mount node is being rewritten, so
   *  the plan's `viewWhere`/`source` may have shifted under the watcher.
   *  Per MVP: targeted, not a global storm. */
  function vpsForConfigChange(path: string): string[] {
    return activeQueries.filter(q => q.vp === path).map(q => q.vp);
  }

  /** Invalidate every active query whose source could be affected by an
   *  external write at `path`. Match cases:
   *    1. path === q.source                — direct change of source node
   *    2. path is a direct child of source — normal vp membership rule
   *    3. path is an ANCESTOR of source    — ACL/config change up the tree
   *    4. path === q.vp                    — the query mount node itself
   *       was rewritten (e.g. match changed); listing now stale
   *  Grand-descendants are skipped (can't affect direct-child queries). */
  function vpsForExternalPath(path: string): string[] {
    const vps: string[] = [];
    for (const q of activeQueries) {
      const prefix = q.source === '/' ? '/' : q.source + '/';
      const directChild = path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
      const isSource = path === q.source;
      const isAncestor = path === '/' || (q.source !== '/' && q.source.startsWith(path + '/'));
      const isVp = path === q.vp;
      if (directChild || isSource || isAncestor || isVp) vps.push(q.vp);
    }
    return vps;
  }

  /** Claims change for `userId` → every query this user subscribes to goes
   *  dirty. The invalidate is a broadcast field — co-watchers of the same vp
   *  over-refetch; bounded and rare (claims changes), accepted (gk8.12). */
  function vpsForClaimsChange(userId: string): string[] {
    return activeQueries.filter(q => q.users.has(userId)).map(q => q.vp);
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
    if (activeQueries.length === 0) return [];

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

    return activeQueries
      .filter(q => isAtOrAbove(path, q.source) || isDirectChildOf(q.source, path))
      .map(q => q.vp);
  }

  /** Membership test for a direct child of a query source — ONCE per
   *  mutation, against the RAW node, no per-user ACL (gk8.12). A flip in
   *  either direction dirties the vp; in-folder updates of unchanged
   *  membership ride the ordinary path event (items are exact-watched). */
  function membershipVps(path: string, oldNode: NodeData | null, newNode: NodeData | null): string[] {
    const oldSift = oldNode ? mapNodeForSift(oldNode) : null;
    const newSift = newNode ? mapNodeForSift(newNode) : null;
    const vps: string[] = [];
    for (const q of activeQueries) {
      const prefix = q.source === '/' ? '/' : q.source + '/';
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      const wasIn = oldSift ? q.test(oldSift) : false;
      const isIn = newSift ? q.test(newSift) : false;
      if (wasIn !== isIn) vps.push(q.vp);
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

    async set(node, ctx) {
      // Defense in depth: strip string $patches if injected
      if ('$patches' in node) {
        node = { ...node };
        delete node['$patches'];
      }

      const oldNode = await tree.get(node.$path, ctx);

      await tree.set(node, ctx);
      const claimsUid = claimsUserOf(node.$path);
      const cdc = dirtyVps(
        membershipVps(node.$path, oldNode ?? null, node),
        (isAclChange(oldNode ?? null, node) || isComponentAclChange(oldNode ?? null, node)) ? vpsForAclChange(node.$path) : [],
        // Config write: either side carries a mount/config component — the vp
        // node itself is being rewritten, handles on it must re-fetch.
        isConfigNode(oldNode) || isConfigNode(node) ? vpsForConfigChange(node.$path) : [],
        claimsUid ? vpsForClaimsChange(claimsUid) : [],
      );

      const { $path, ...body } = node;
      const by = opIdOf(ctx);

      if (oldNode) {
        const computed = diffNodes(oldNode, node);
        emit(computed.length > 0
          ? { type: 'patch', path: $path, patches: computed, rev: node.$rev, ...(by ? { by } : {}), ...cdc }
          : { type: 'set', path: $path, node: body, ...(by ? { by } : {}), ...cdc });
      } else {
        emit({ type: 'set', path: $path, node: body, ...(by ? { by } : {}), ...cdc });
      }
    },

    async remove(path, ctx) {
      const oldNode = await tree.get(path, ctx);
      const claimsUid = claimsUserOf(path);
      // Remove drops $acl entirely — treat as ACL change so subscribers
      // re-fetch (visibility of siblings whose ACL inheritance chain ran
      // through this node may flip).
      const cdc = oldNode
        ? dirtyVps(
            membershipVps(path, oldNode, null),
            (oldNode.$acl || oldNode.$owner || isComponentAclChange(oldNode, null)) ? vpsForAclChange(path) : [],
            isConfigNode(oldNode) ? vpsForConfigChange(path) : [],
            claimsUid ? vpsForClaimsChange(claimsUid) : [],
          )
        : undefined;
      const result = await tree.remove(path, ctx);

      if (result && oldNode) {
        const by = opIdOf(ctx);
        emit({ type: 'remove', path, ...(by ? { by } : {}), ...cdc });
      }
      return result;
    },

    async patch(path, ops, ctx) {
      const oldNode = await tree.get(path, ctx);

      await tree.patch(path, ops, ctx);

      const newNode = await tree.get(path, ctx);
      // Config write detection on patch: either node had/has config, or an op
      // touched the `mount` field directly (covers add/replace of the
      // component on a previously-non-config node).
      const opsTouchedMount = ops.some(op => {
        const p = op[1];
        return p === '#mount' || p.startsWith('#mount.');
      });
      const claimsUid = claimsUserOf(path);
      const cdc = dirtyVps(
        membershipVps(path, oldNode ?? null, newNode ?? null),
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
    },
  };

  const cdc: CdcRegistry = {
    subscribe(path, listener, opts) {
      return internalSubscribe(path, listener, opts);
    },

    watchQuery(vp, source, match, userId) {
      const matchKey = stableJson(match);
      let entry = activeQueries.find(q => q.vp === vp);
      if (!entry) {
        entry = { vp, source, match, matchKey, test: createSiftTest(match), users: new Set() };
        activeQueries.push(entry);
      } else if (entry.source !== source || entry.matchKey !== matchKey) {
        // E03: vp reused with different source/match — update definition
        entry.source = source;
        entry.match = match;
        entry.matchKey = matchKey;
        entry.test = createSiftTest(match);
      }
      entry.users.add(userId);
    },

    unwatchQuery(vp, userId) {
      const idx = activeQueries.findIndex(q => q.vp === vp);
      if (idx === -1) return;
      const entry = activeQueries[idx];
      entry.users.delete(userId);
      if (entry.users.size === 0) activeQueries.splice(idx, 1);
    },

    unwatchAllQueries(userId) {
      for (let i = activeQueries.length - 1; i >= 0; i--) {
        activeQueries[i].users.delete(userId);
        if (activeQueries[i].users.size === 0) activeQueries.splice(i, 1);
      }
    },

    getActiveQueryCount() {
      return activeQueries.length;
    },
  };

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
