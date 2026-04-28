// Treenix Subscriptions — Layer 3
// Wraps any Tree, emits events on set/remove.
// No dependencies beyond Tree + core types.

import { type SubscribeOpts } from '#contexts/service/index';
import { type NodeData } from '#core';
import { type PatchOp, toRfc6902, type Tree } from '#tree';
import { createSiftTest, mapNodeForSift } from '#tree/query';
import type { Operation } from 'fast-json-patch';
import fjp from 'fast-json-patch';

const { compare } = fjp;

// ── Event types ──

export type NodeEvent =
  | { type: 'set'; path: string; node: Omit<NodeData, '$path'>; addVps?: string[]; rmVps?: string[]; stayVps?: string[] }
  | { type: 'patch'; path: string; patches: Operation[]; rev?: number; addVps?: string[]; rmVps?: string[]; stayVps?: string[] }
  | { type: 'remove'; path: string; rmVps?: string[] }
  | { type: 'reconnect'; preserved: boolean };

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
  test: (node: Record<string, unknown>) => boolean;
  users: Set<string>;
};

export type CdcRegistry = {
  subscribe(path: string, listener: Listener, opts?: SubscribeOpts): () => void;
  watchQuery(vp: string, source: string, match: Record<string, unknown>, userId: string): void;
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

  /** Evaluate CDC matrix for a direct child of a query source */
  function cdcEval(path: string, oldNode: NodeData | null, newNode: NodeData | null) {
    const addVps: string[] = [];
    const rmVps: string[] = [];
    const stayVps: string[] = [];
    const oldSift = oldNode ? mapNodeForSift(oldNode) : null;
    const newSift = newNode ? mapNodeForSift(newNode) : null;

    for (const q of activeQueries) {
      const prefix = q.source === '/' ? '/' : q.source + '/';
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;

      const wasIn = oldSift ? q.test(oldSift) : false;
      const isIn = newSift ? q.test(newSift) : false;

      if (!wasIn && isIn) addVps.push(q.vp);
      else if (wasIn && !isIn) rmVps.push(q.vp);
      else if (wasIn && isIn) stayVps.push(q.vp);
    }

    return { addVps, rmVps, stayVps };
  }

  const wrappedTree: Tree = {
    get: tree.get.bind(tree),
    getChildren: tree.getChildren.bind(tree),

    async set(node, ctx) {
      // Defense in depth: strip string $patches if injected
      if ('$patches' in node) {
        node = { ...node };
        delete node['$patches'];
      }

      const oldNode = await tree.get(node.$path, ctx);
      const { addVps, rmVps, stayVps } = cdcEval(node.$path, oldNode ?? null, node);

      await tree.set(node, ctx);

      const { $path, ...body } = node;

      if (oldNode) {
        const computed = compare(oldNode, node);
        emit(computed.length > 0
          ? { type: 'patch', path: $path, patches: computed, rev: node.$rev, addVps, rmVps, stayVps }
          : { type: 'set', path: $path, node: body, addVps, rmVps, stayVps });
      } else {
        emit({ type: 'set', path: $path, node: body, addVps, rmVps, stayVps });
      }
    },

    async remove(path, ctx) {
      const oldNode = await tree.get(path, ctx);
      const result = await tree.remove(path, ctx);

      if (result && oldNode) {
        const { rmVps } = cdcEval(path, oldNode, null);
        emit({ type: 'remove', path, ...(rmVps.length > 0 ? { rmVps } : {}) });
      }
      return result;
    },

    async patch(path, ops, ctx) {
      const oldNode = await tree.get(path, ctx);

      await tree.patch(path, ops, ctx);

      const newNode = await tree.get(path, ctx);
      const { addVps, rmVps, stayVps } = cdcEval(path, oldNode ?? null, newNode ?? null);

      // Emit only mutation ops (filter out test ops)
      const mutations = ops.filter((o): o is Exclude<PatchOp, readonly ['t', ...any]> => o[0] !== 't');
      if (mutations.length > 0) {
        emit({ type: 'patch', path, patches: toRfc6902(mutations) as Operation[], rev: newNode?.$rev, addVps, rmVps, stayVps });
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

    watchQuery(vp, source, match, userId) {
      let entry = activeQueries.find(q => q.vp === vp);
      if (!entry) {
        entry = { vp, source, test: createSiftTest(match), users: new Set() };
        activeQueries.push(entry);
      } else if (entry.source !== source) {
        // E03: vp reused with different source/match — update definition
        entry.source = source;
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

  return { tree: wrappedTree, cdc };
}
