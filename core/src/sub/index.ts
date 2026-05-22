// Treenix Subscriptions — Layer 3
// Wraps any Tree, emits events on set/remove.
// No dependencies beyond Tree + core types.

import { type SubscribeOpts } from '#contexts/service/index';
import { A, R, type NodeData } from '#core';
import { buildClaims, resolvePermission, stripComponents } from '#security/auth';
import { mapNodeForSift, type PatchOp, toRfc6902, type Tree } from '#tree';
import { createSiftTest } from '#tree/query';
import type { Operation } from 'fast-json-patch';
import fjp from 'fast-json-patch';

const { compare } = fjp;

// ── Event types ──

export type NodeEvent =
  | { type: 'set'; path: string; node: Omit<NodeData, '$path'>; addVps?: string[]; rmVps?: string[]; stayVps?: string[]; invalidateVps?: string[] }
  | { type: 'patch'; path: string; patches: Operation[]; rev?: number; addVps?: string[]; rmVps?: string[]; stayVps?: string[]; invalidateVps?: string[] }
  | { type: 'remove'; path: string; rmVps?: string[]; invalidateVps?: string[] }
  | { type: 'reconnect'; preserved: boolean };

// invalidateVps: virtual paths whose visibility/membership may have shifted
// due to an ACL or config change. Client should re-fetch the listing. The
// runtime cannot exact-diff these — unlike addVps/rmVps which come from a
// data mutation on a direct child of the query source.
export type VpDelta = { addVps?: string[]; rmVps?: string[]; stayVps?: string[]; invalidateVps?: string[] };
export const CDC_ROUTES: unique symbol = Symbol('treenix.cdcRoutes');
export type RoutedNodeEvent = NodeEvent & { [CDC_ROUTES]?: Map<string, VpDelta> };

// Strip empty arrays and $path from node to keep wire format clean
function cleanEvent<T extends NodeEvent>(event: T): T {
  const e = { ...event };
  if ('addVps' in e && e.addVps && e.addVps.length === 0) delete e.addVps;
  if ('rmVps' in e && e.rmVps && e.rmVps.length === 0) delete e.rmVps;
  if ('stayVps' in e && e.stayVps && e.stayVps.length === 0) delete e.stayVps;
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

// ── CDC Registry (instance-scoped) ──

type QueryEntry = {
  vp: string;
  source: string;
  matchKey: string;
  match: Record<string, unknown>;
  test: (node: Record<string, unknown>) => boolean;
  users: Map<string, { claims: string[] | null | undefined; dynamicClaims?: string[]; dynamicAt?: number }>;
};

type MutableVpDelta = { addVps: string[]; rmVps: string[]; stayVps: string[]; invalidateVps: string[] };

export type CdcRegistry = {
  subscribe(path: string, listener: Listener, opts?: SubscribeOpts): () => void;
  watchQuery(vp: string, source: string, match: Record<string, unknown>, userId: string, claims?: string[] | null): void;
  unwatchQuery(vp: string, userId: string): void;
  unwatchAllQueries(userId: string): void;
  getActiveQueryCount(): number;
};

export function withSubscriptions(
  tree: Tree,
  onEvent?: (event: NodeEvent) => void,
): { tree: Tree; cdc: CdcRegistry } {
  const exactListeners = new Map<string, Set<Listener>>();
  const prefixListeners = new Map<string, Set<Listener>>();
  const activeQueries: QueryEntry[] = [];
  const CLAIMS_TTL_MS = 30_000;

  function stableJson(value: unknown): string {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }

  type DataEvent = Exclude<NodeEvent, { type: 'reconnect' }>;

  function emit(raw: DataEvent) {
    const event = cleanEvent(raw);

    const exact = exactListeners.get(event.path);
    if (exact) for (const fn of exact) fn(event);

    for (const [prefix, subs] of prefixListeners) {
      if (event.path === prefix || event.path.startsWith(prefix === '/' ? '/' : prefix + '/')) {
        for (const fn of subs) fn(event);
      }
    }

    onEvent?.(event);
  }

  function addDelta(delta: MutableVpDelta, kind: keyof MutableVpDelta, vp: string) {
    delta[kind].push(vp);
  }

  function routeDelta(routes: Map<string, MutableVpDelta>, userId: string): MutableVpDelta {
    let delta = routes.get(userId);
    if (!delta) {
      delta = { addVps: [], rmVps: [], stayVps: [], invalidateVps: [] };
      routes.set(userId, delta);
    }
    return delta;
  }

  async function claimsFor(q: QueryEntry, userId: string): Promise<string[]> {
    const user = q.users.get(userId)!;
    if (user.claims) return user.claims;
    if (!user.dynamicClaims || Date.now() - (user.dynamicAt ?? 0) > CLAIMS_TTL_MS) {
      user.dynamicClaims = await buildClaims(tree, userId);
      user.dynamicAt = Date.now();
    }
    return user.dynamicClaims;
  }

  async function visibleSiftNode(node: NodeData, userId: string, claims: string[]): Promise<Record<string, unknown> | null> {
    const perm = await resolvePermission(tree, node.$path, userId, claims);
    if (!(perm & R)) return null;
    const visible = stripComponents(node, userId, claims);
    if (!(perm & A)) {
      delete visible.$acl;
      delete visible.$owner;
    }
    return mapNodeForSift(visible);
  }

  /** Compute invalidate-vp set for a mount/config write. Targets handles
   *  whose vp IS the mutated path — the mount node is being rewritten, so
   *  the plan's `viewWhere`/`source` may have shifted under the watcher.
   *  Per MVP: targeted, not a global storm. */
  function invalidateVpsForConfigChange(path: string): { vps: string[]; routes: Map<string, MutableVpDelta> } {
    const vps: string[] = [];
    const routes = new Map<string, MutableVpDelta>();
    for (const q of activeQueries) {
      if (q.vp !== path) continue;
      vps.push(q.vp);
      for (const userId of q.users.keys()) {
        addDelta(routeDelta(routes, userId), 'invalidateVps', q.vp);
      }
    }
    return { vps, routes };
  }

  /** True if the node carries a mount component that would steer this path
   *  to a different sub-tree. Used to detect config writes. */
  function hasMountComponent(node: NodeData | null | undefined): boolean {
    if (!node) return false;
    const m = node['mount'];
    return !!m && typeof m === 'object' && (m as { $type?: string }).$type !== undefined;
  }

  /** Extract a userId from `/auth/users/{userId}` paths. Returns null when
   *  the path doesn't match (or has a deeper segment — only the user node
   *  itself, not sub-paths, drives the claims rebuild). */
  function userIdFromAuthPath(path: string): string | null {
    const prefix = '/auth/users/';
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length);
    if (!rest || rest.includes('/')) return null;
    return rest;
  }

  /** Compute invalidate-vp set for a user-claims change at `userId`. Every
   *  active query that has this user gets the user's vps invalidated.
   *  Also resets the cached dynamicClaims so the next read recomputes. */
  function invalidateVpsForClaimsChange(userId: string): { vps: string[]; routes: Map<string, MutableVpDelta> } {
    const vps: string[] = [];
    const routes = new Map<string, MutableVpDelta>();
    for (const q of activeQueries) {
      const user = q.users.get(userId);
      if (!user) continue;
      // Force claimsFor to refresh on next access.
      user.dynamicClaims = undefined;
      user.dynamicAt = undefined;
      vps.push(q.vp);
      addDelta(routeDelta(routes, userId), 'invalidateVps', q.vp);
    }
    return { vps, routes };
  }

  /** Compute invalidate-vp set for an ACL change at `path`. ACL inherits
   *  DOWN the tree, so an ACL change at P affects every descendant of P
   *  (incl. P itself). For a depth-1 query view rooted at `source`, the
   *  set of affected paths is:
   *    1. P is at-or-above source (source ∈ {P, descendants of P})
   *    2. P is a direct child of source (P's ACL was the membership gate)
   *  Per-user filter: legacy raw watchers (no claims) always get the
   *  invalidate; modern watchers get it only when they have R on P —
   *  otherwise the invalidate itself would leak existence. */
  async function invalidateVpsForAclChange(path: string): Promise<{ vps: string[]; routes: Map<string, MutableVpDelta> }> {
    const vps: string[] = [];
    const routes = new Map<string, MutableVpDelta>();
    if (activeQueries.length === 0) return { vps, routes };

    function isAtOrAbove(p: string, candidate: string): boolean {
      // candidate is `p` itself or a descendant — i.e., `p` is on the
      // ancestor chain of candidate.
      if (p === '/' || p === candidate) return true;
      return candidate.startsWith(p + '/');
    }
    function isDirectChild(parent: string, candidate: string): boolean {
      const prefix = parent === '/' ? '/' : parent + '/';
      if (!candidate.startsWith(prefix)) return false;
      const rest = candidate.slice(prefix.length);
      return rest.length > 0 && !rest.includes('/');
    }

    for (const q of activeQueries) {
      const affects = isAtOrAbove(path, q.source) || isDirectChild(q.source, path);
      if (!affects) continue;
      let anyUserAffected = false;
      for (const [userId, user] of q.users) {
        if (user.claims !== undefined) {
          const claims = await claimsFor(q, userId);
          const perm = await resolvePermission(tree, path, userId, claims);
          if (!(perm & R)) continue;
        }
        addDelta(routeDelta(routes, userId), 'invalidateVps', q.vp);
        anyUserAffected = true;
      }
      if (anyUserAffected) vps.push(q.vp);
    }
    return { vps, routes };
  }

  /** Evaluate CDC matrix for a direct child of a query source */
  async function cdcEval(path: string, oldNode: NodeData | null, newNode: NodeData | null): Promise<VpDelta & { [CDC_ROUTES]?: Map<string, VpDelta> }> {
    const addVps: string[] = [];
    const rmVps: string[] = [];
    const stayVps: string[] = [];
    const oldSift = oldNode ? mapNodeForSift(oldNode) : null;
    const newSift = newNode ? mapNodeForSift(newNode) : null;
    const routes = new Map<string, MutableVpDelta>();

    for (const q of activeQueries) {
      const prefix = q.source === '/' ? '/' : q.source + '/';
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;

      let hasLegacyRawUser = false;
      for (const user of q.users.values()) {
        if (user.claims === undefined) {
          hasLegacyRawUser = true;
          break;
        }
      }

      if (hasLegacyRawUser) {
        const wasIn = oldSift ? q.test(oldSift) : false;
        const isIn = newSift ? q.test(newSift) : false;
        let kind: keyof MutableVpDelta | null = null;
        if (!wasIn && isIn) {
          addVps.push(q.vp);
          kind = 'addVps';
        } else if (wasIn && !isIn) {
          rmVps.push(q.vp);
          kind = 'rmVps';
        } else if (wasIn && isIn) {
          stayVps.push(q.vp);
          kind = 'stayVps';
        }
        if (kind) {
          for (const [userId, user] of q.users) {
            if (user.claims === undefined) addDelta(routeDelta(routes, userId), kind, q.vp);
          }
        }
      }

      for (const userId of q.users.keys()) {
        const user = q.users.get(userId)!;
        if (user.claims === undefined) continue;
        const claims = await claimsFor(q, userId);
        const oldVisible = oldNode ? await visibleSiftNode(oldNode, userId, claims) : null;
        const newVisible = newNode ? await visibleSiftNode(newNode, userId, claims) : null;
        const wasIn = oldVisible ? q.test(oldVisible) : false;
        const isIn = newVisible ? q.test(newVisible) : false;
        if (!wasIn && !isIn) continue;

        const delta = routeDelta(routes, userId);
        if (!wasIn && isIn) addDelta(delta, 'addVps', q.vp);
        else if (wasIn && !isIn) addDelta(delta, 'rmVps', q.vp);
        else if (wasIn && isIn) addDelta(delta, 'stayVps', q.vp);
      }
    }

    const secureRoutes = new Map<string, VpDelta>();
    for (const [userId, delta] of routes) {
      const out: VpDelta = {};
      if (delta.addVps.length > 0) out.addVps = delta.addVps;
      if (delta.rmVps.length > 0) out.rmVps = delta.rmVps;
      if (delta.stayVps.length > 0) out.stayVps = delta.stayVps;
      if (delta.invalidateVps.length > 0) out.invalidateVps = delta.invalidateVps;
      if (out.addVps || out.rmVps || out.stayVps || out.invalidateVps) secureRoutes.set(userId, out);
    }
    const result: VpDelta & { [CDC_ROUTES]?: Map<string, VpDelta> } = { addVps, rmVps, stayVps };
    if (secureRoutes.size > 0) result[CDC_ROUTES] = secureRoutes;
    return result;
  }

  /** Merge an ACL/config invalidation into the existing cdcEval routes.
   *  Used by set/patch/remove when the mutation touched $acl/$owner — the
   *  same affected query may also have data-diff entries from cdcEval, and
   *  invalidate takes precedence on the client (re-fetch supersedes diff). */
  function mergeInvalidate(
    base: VpDelta & { [CDC_ROUTES]?: Map<string, VpDelta> },
    invalidate: { vps: string[]; routes: Map<string, MutableVpDelta> },
  ): VpDelta & { [CDC_ROUTES]?: Map<string, VpDelta> } {
    if (invalidate.vps.length === 0) return base;
    const merged: VpDelta & { [CDC_ROUTES]?: Map<string, VpDelta> } = { ...base };
    merged.invalidateVps = [...(base.invalidateVps ?? []), ...invalidate.vps];
    const existingRoutes = base[CDC_ROUTES] ?? new Map<string, VpDelta>();
    const newRoutes = new Map(existingRoutes);
    for (const [userId, delta] of invalidate.routes) {
      const prev = newRoutes.get(userId) ?? {};
      newRoutes.set(userId, {
        ...prev,
        invalidateVps: [...(prev.invalidateVps ?? []), ...delta.invalidateVps],
      });
    }
    if (newRoutes.size > 0) merged[CDC_ROUTES] = newRoutes;
    return merged;
  }

  const wrappedTree: Tree = {
    get: tree.get.bind(tree),
    getChildren: tree.getChildren.bind(tree),
    // Forward only when inner exposes it; sub/ never enriches scans.
    ...(tree.scanChildren ? { scanChildren: tree.scanChildren.bind(tree) } : {}),

    async set(node, ctx) {
      // Defense in depth: strip string $patches if injected
      if ('$patches' in node) {
        node = { ...node };
        delete node['$patches'];
      }

      const oldNode = await tree.get(node.$path, ctx);

      await tree.set(node, ctx);
      let cdc = await cdcEval(node.$path, oldNode ?? null, node);
      if (isAclChange(oldNode ?? null, node)) {
        cdc = mergeInvalidate(cdc, await invalidateVpsForAclChange(node.$path));
      }
      // Config write: either side carries a mount component. The mount node
      // itself is being rewritten, so handles registered against this vp
      // must re-fetch.
      if (hasMountComponent(oldNode) || hasMountComponent(node)) {
        cdc = mergeInvalidate(cdc, invalidateVpsForConfigChange(node.$path));
      }
      const claimsUid = userIdFromAuthPath(node.$path);
      if (claimsUid) {
        cdc = mergeInvalidate(cdc, invalidateVpsForClaimsChange(claimsUid));
      }

      const { $path, ...body } = node;

      if (oldNode) {
        const computed = compare(oldNode, node);
        emit(computed.length > 0
          ? { type: 'patch', path: $path, patches: computed, rev: node.$rev, ...cdc }
          : { type: 'set', path: $path, node: body, ...cdc });
      } else {
        emit({ type: 'set', path: $path, node: body, ...cdc });
      }
    },

    async remove(path, ctx) {
      const oldNode = await tree.get(path, ctx);
      let cdc = oldNode ? await cdcEval(path, oldNode, null) : undefined;
      // Remove drops $acl entirely — treat as ACL change so subscribers
      // re-fetch (the data-diff path already removes the node; invalidate
      // covers the case where the removal also flips visibility of siblings
      // whose ACL inheritance chain ran through this node).
      if (oldNode && (oldNode.$acl || oldNode.$owner) && cdc) {
        cdc = mergeInvalidate(cdc, await invalidateVpsForAclChange(path));
      }
      // Removing a mount node: handles bound to this vp must re-fetch.
      if (hasMountComponent(oldNode) && cdc) {
        cdc = mergeInvalidate(cdc, invalidateVpsForConfigChange(path));
      }
      const claimsUid = userIdFromAuthPath(path);
      if (claimsUid && cdc) {
        cdc = mergeInvalidate(cdc, invalidateVpsForClaimsChange(claimsUid));
      }
      const result = await tree.remove(path, ctx);

      if (result && oldNode) {
        emit({ type: 'remove', path, ...cdc });
      }
      return result;
    },

    async patch(path, ops, ctx) {
      const oldNode = await tree.get(path, ctx);

      await tree.patch(path, ops, ctx);

      const newNode = await tree.get(path, ctx);
      let cdc = await cdcEval(path, oldNode ?? null, newNode ?? null);
      // Both directions: ops touched $acl/$owner directly OR the resulting
      // diff shows a $acl change (covers full-node replace via patch).
      if (ops.some(isAclOp) || isAclChange(oldNode ?? null, newNode ?? null)) {
        cdc = mergeInvalidate(cdc, await invalidateVpsForAclChange(path));
      }
      // Config write detection on patch: either node had/has a mount, or
      // an op touched the `mount` field directly (covers add/replace of
      // the component on a previously-non-mount node).
      const opsTouchedMount = ops.some(op => {
        const p = op[1];
        return p === 'mount' || p.startsWith('mount.');
      });
      if (opsTouchedMount || hasMountComponent(oldNode) || hasMountComponent(newNode)) {
        cdc = mergeInvalidate(cdc, invalidateVpsForConfigChange(path));
      }
      const claimsUid = userIdFromAuthPath(path);
      if (claimsUid) {
        cdc = mergeInvalidate(cdc, invalidateVpsForClaimsChange(claimsUid));
      }

      // Emit only mutation ops (filter out test ops)
      const mutations = ops.filter((o): o is Exclude<PatchOp, readonly ['t', ...any]> => o[0] !== 't');
      if (mutations.length > 0) {
        emit({ type: 'patch', path, patches: toRfc6902(mutations) as Operation[], rev: newNode?.$rev, ...cdc });
      }
    },
  };

  const cdc: CdcRegistry = {
    subscribe(path, listener, opts) {
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
    },

    watchQuery(vp, source, match, userId, claims) {
      const matchKey = stableJson(match);
      let entry = activeQueries.find(q => q.vp === vp);
      if (!entry) {
        entry = { vp, source, match, matchKey, test: createSiftTest(match), users: new Map() };
        activeQueries.push(entry);
      } else if (entry.source !== source || entry.matchKey !== matchKey) {
        // E03: vp reused with different source/match — update definition
        entry.source = source;
        entry.match = match;
        entry.matchKey = matchKey;
        entry.test = createSiftTest(match);
      }
      entry.users.set(userId, { claims });
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

  return { tree: wrappedTree, cdc };
}
