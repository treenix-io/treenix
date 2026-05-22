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
  | { type: 'set'; path: string; node: Omit<NodeData, '$path'>; addVps?: string[]; rmVps?: string[]; stayVps?: string[] }
  | { type: 'patch'; path: string; patches: Operation[]; rev?: number; addVps?: string[]; rmVps?: string[]; stayVps?: string[] }
  | { type: 'remove'; path: string; rmVps?: string[] }
  | { type: 'reconnect'; preserved: boolean };

export type VpDelta = { addVps?: string[]; rmVps?: string[]; stayVps?: string[] };
export const CDC_ROUTES: unique symbol = Symbol('treenix.cdcRoutes');
export type RoutedNodeEvent = NodeEvent & { [CDC_ROUTES]?: Map<string, VpDelta> };

// Strip empty arrays and $path from node to keep wire format clean
function cleanEvent<T extends NodeEvent>(event: T): T {
  const e = { ...event };
  if ('addVps' in e && e.addVps && e.addVps.length === 0) delete e.addVps;
  if ('rmVps' in e && e.rmVps && e.rmVps.length === 0) delete e.rmVps;
  if ('stayVps' in e && e.stayVps && e.stayVps.length === 0) delete e.stayVps;
  return e;
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

type MutableVpDelta = { addVps: string[]; rmVps: string[]; stayVps: string[] };

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
      delta = { addVps: [], rmVps: [], stayVps: [] };
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
      if (out.addVps || out.rmVps || out.stayVps) secureRoutes.set(userId, out);
    }
    const result: VpDelta & { [CDC_ROUTES]?: Map<string, VpDelta> } = { addVps, rmVps, stayVps };
    if (secureRoutes.size > 0) result[CDC_ROUTES] = secureRoutes;
    return result;
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
      const cdc = await cdcEval(node.$path, oldNode ?? null, node);

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
      const cdc = oldNode ? await cdcEval(path, oldNode, null) : undefined;
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
      const cdc = await cdcEval(path, oldNode ?? null, newNode ?? null);

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
