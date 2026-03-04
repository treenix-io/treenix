// Treenity Subscriptions — Layer 3
// Wraps any Tree, emits events on set/remove.
// No dependencies beyond Tree + core types.

import { type SubscribeOpts } from '#contexts/service/index';
import { type NodeData } from '#core';
import { type PatchOp, toRfc6902, type Tree } from '#tree';
import { createSiftTest, mapNodeForSift } from '#tree/query';
import type { Operation } from 'fast-json-patch';
import fjp from 'fast-json-patch';
import { type Patch } from 'immer';

const { compare } = fjp;

// Immer Patch {path: ['a','b']} → RFC 6902 Operation {path: '/a/b'}
function immerToRfc(patches: Patch[]): Operation[] {
  return patches.map(p => ({ ...p, path: '/' + p.path.join('/') }) as Operation);
}

// ── Event types ──

export type NodeEvent =
  | { type: 'set'; path: string; node: Omit<NodeData, '$path'>; addVps?: string[]; rmVps?: string[] }
  | { type: 'patch'; path: string; patches: Operation[]; addVps?: string[]; rmVps?: string[] }
  | { type: 'remove'; path: string; rmVps?: string[] }
  | { type: 'reconnect'; preserved: boolean };

// Strip empty arrays and $path from node to keep wire format clean
function cleanEvent(event: NodeEvent): NodeEvent {
  const e = { ...event };
  if ('addVps' in e && e.addVps && e.addVps.length === 0) delete e.addVps;
  if ('rmVps' in e && e.rmVps && e.rmVps.length === 0) delete e.rmVps;
  return e;
}

export type Listener = (event: NodeEvent) => void;

// ── Query Registry ──
// Stores active queries (mounts) for CDC evaluation
type QueryEntry = {
  vp: string; // Virtual parent path (e.g. /orders/incoming)
  source: string; // Source collection path (e.g. /orders/data)
  test: (node: Record<string, unknown>) => boolean; // Sift compiled query
  users: Set<string>; // Who is watching this vp
};

const activeQueries: QueryEntry[] = [];

export function watchQuery(vp: string, source: string, match: Record<string, unknown>, userId: string) {
  let entry = activeQueries.find(q => q.vp === vp);
  if (!entry) {
    entry = { vp, source, test: createSiftTest(match), users: new Set() };
    activeQueries.push(entry);
  }
  entry.users.add(userId);
}

export function unwatchQuery(vp: string, userId: string) {
  const idx = activeQueries.findIndex(q => q.vp === vp);
  if (idx === -1) return;
  const entry = activeQueries[idx];
  entry.users.delete(userId);
  if (entry.users.size === 0) activeQueries.splice(idx, 1);
}

export function unwatchAllQueries(userId: string) {
  for (let i = activeQueries.length - 1; i >= 0; i--) {
    activeQueries[i].users.delete(userId);
    if (activeQueries[i].users.size === 0) activeQueries.splice(i, 1);
  }
}

export function getActiveQueryCount(): number {
  return activeQueries.length;
}

// ── Reactive store wrapper ──

export interface ReactiveTree extends Tree {
  subscribe(path: string, listener: Listener, opts?: SubscribeOpts): () => void;
}

export function withSubscriptions(
  store: Tree,
  onEvent?: (event: NodeEvent) => void,
): ReactiveTree {
  const exactListeners = new Map<string, Set<Listener>>();
  const prefixListeners = new Map<string, Set<Listener>>();

  type DataEvent = Exclude<NodeEvent, { type: 'reconnect' }>;

  function emit(raw: DataEvent) {
    const event = cleanEvent(raw) as DataEvent;

    const exact = exactListeners.get(event.path);
    if (exact) for (const fn of exact) fn(event);

    for (const [prefix, subs] of prefixListeners) {
      if (event.path === prefix || event.path.startsWith(prefix === '/' ? '/' : prefix + '/')) {
        for (const fn of subs) fn(event);
      }
    }

    onEvent?.(event);
  }

  return {
    get: store.get.bind(store),
    getChildren: store.getChildren.bind(store),

    async set(node) {
      const patches = node['$patches'] as Patch[] | undefined;
      if (patches) {
        node = { ...node };
        delete node['$patches'];
      }

      const oldNode = await store.get(node.$path);

      // CDC Matrix Evaluation
      const addVps: string[] = [];
      const rmVps: string[] = [];

      const newNodeSift = mapNodeForSift(node);
      const oldNodeSift = oldNode ? mapNodeForSift(oldNode) : null;

      for (const q of activeQueries) {
        // Only evaluate if node is a direct child of the query's source
        const prefix = q.source === '/' ? '/' : q.source + '/';
        if (node.$path.startsWith(prefix) && node.$path.slice(prefix.length).indexOf('/') === -1) {
          const wasIn = oldNodeSift ? q.test(oldNodeSift) : false;
          const isIn = q.test(newNodeSift);

          if (!wasIn && isIn) addVps.push(q.vp);
          if (wasIn && !isIn) rmVps.push(q.vp);
          // If wasIn && isIn, it's an update, which is handled by exact path watch
        }
      }

      await store.set(node);

      const { $path, ...body } = node;

      if (patches && patches.length > 0) {
        // Immer patches from actions → convert to RFC 6902
        emit({ type: 'patch', path: $path, patches: immerToRfc(patches), addVps, rmVps });
      } else if (oldNode) {
        // Compute minimal RFC 6902 patches via deep comparison
        const computed = compare(oldNode, node);
        emit(computed.length > 0
          ? { type: 'patch', path: $path, patches: computed, addVps, rmVps }
          : { type: 'set', path: $path, node: body, addVps, rmVps });
      } else {
        // New node — no old state to diff against
        emit({ type: 'set', path: $path, node: body, addVps, rmVps });
      }
    },

    async remove(path) {
      const oldNode = await store.get(path);
      const result = await store.remove(path);

      if (result && oldNode) {
        const rmVps: string[] = [];
        const oldNodeSift = mapNodeForSift(oldNode);

        for (const q of activeQueries) {
          const prefix = q.source === '/' ? '/' : q.source + '/';
          if (path.startsWith(prefix) && path.slice(prefix.length).indexOf('/') === -1) {
             if (q.test(oldNodeSift)) {
               rmVps.push(q.vp);
             }
          }
        }
        emit({ type: 'remove', path, ...(rmVps.length > 0 ? { rmVps } : {}) });
      }
      return result;
    },

    async patch(path, ops, ctx) {
      const oldNode = await store.get(path);

      await store.patch(path, ops, ctx);

      // CDC Matrix — read new state to check virtual path changes
      const newNode = await store.get(path);
      const addVps: string[] = [];
      const rmVps: string[] = [];

      if (oldNode && newNode) {
        const oldSift = mapNodeForSift(oldNode);
        const newSift = mapNodeForSift(newNode);
        for (const q of activeQueries) {
          const prefix = q.source === '/' ? '/' : q.source + '/';
          if (path.startsWith(prefix) && path.slice(prefix.length).indexOf('/') === -1) {
            const wasIn = q.test(oldSift);
            const isIn = q.test(newSift);
            if (!wasIn && isIn) addVps.push(q.vp);
            if (wasIn && !isIn) rmVps.push(q.vp);
          }
        }
      }

      // Emit only mutation ops (filter out test ops)
      const mutations = ops.filter((o): o is Exclude<PatchOp, readonly ['t', ...any]> => o[0] !== 't');
      if (mutations.length > 0) {
        emit({ type: 'patch', path, patches: toRfc6902(mutations) as Operation[], addVps, rmVps });
      }
    },

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
  };
}
