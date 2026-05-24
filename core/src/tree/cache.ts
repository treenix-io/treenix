// Treenix Cache Tree — Layer 1
// Flat path-keyed FIFO cache wrapping any Tree.
// Populate on read AND write. Inflight dedup prevents thundering herd.

import type { NodeData } from '#core';
import { createBoundedCache } from '#util/bounded-cache';
import { type Tree, type TreeEvent, type TreeWatchOpts, type TreeWatchScope } from './index';
import { createInflight } from './inflight';
import { patchViaSet } from './patch';

// Cache stores live refs — callers MUST clone before mutating. We tried
// deepFreeze in the past but upper layers (e.g. @treenx/react) attach
// symbol-keyed metadata to returned nodes; freeze broke that.

const DEFAULT_MAX = 5000;

export type CachedTree = Tree & {
  invalidate(path: string): void;
  invalidateAll(): void;
};

export function withCache(tree: Tree, max = DEFAULT_MAX): CachedTree {
  const cache = createBoundedCache<string, NodeData>(max);
  const dedup = createInflight<NodeData | undefined>();
  // Monotonic counter bumped on every invalidate. get() snapshots it at
  // entry and refuses to repopulate cache if it advanced mid-read.
  let invalidateEpoch = 0;

  const wrapper: CachedTree = {
    invalidate(path) { cache.delete(path); invalidateEpoch++; },
    invalidateAll() { cache.clear(); invalidateEpoch++; },

    async get(path, ctx) {
      const cached = cache.get(path);
      if (cached !== undefined) return cached;
      const startEpoch = invalidateEpoch;
      // Inflight key includes epoch so post-invalidate callers start a
      // fresh inner read instead of joining a stale-bound in-flight.
      const inflightKey = `${path}@${startEpoch}`;
      return dedup(inflightKey, async () => {
        const node = await tree.get(path, ctx);
        if (node && invalidateEpoch === startEpoch) cache.set(node.$path, node);
        return node;
      });
    },

    async getChildren(path, opts, ctx) {
      const startEpoch = invalidateEpoch;
      const result = await tree.getChildren(path, opts, ctx);
      if (invalidateEpoch === startEpoch) {
        for (const node of result.items) cache.set(node.$path, node);
      }
      return result;
    },

    ...(tree.scanChildren ? {
      async *scanChildren(parent: string, opts?: Parameters<NonNullable<Tree['scanChildren']>>[1], ctx?: unknown) {
        const startEpoch = invalidateEpoch;
        for await (const entry of tree.scanChildren!(parent, opts, ctx)) {
          if (invalidateEpoch === startEpoch) cache.set(entry.node.$path, entry.node);
          yield entry;
        }
      },
    } : {}),

    async set(node, ctx) {
      await tree.set(node, ctx);
      // Re-read after set to capture the inner store's $rev bump.
      const fresh = await tree.get(node.$path, ctx);
      if (fresh) cache.set(node.$path, fresh);
    },

    async remove(path, ctx) {
      const result = await tree.remove(path, ctx);
      cache.delete(path);
      return result;
    },

    async patch(path, ops, ctx) {
      return patchViaSet(wrapper, path, ops, ctx);
    },

    // Federation-client case: withCache wraps a remote Tree.watch source.
    // Route through wrapper.invalidate so the epoch counter bumps too —
    // raw cache.delete would leave in-flight reads free to repopulate
    // the just-cleared slot.
    ...(tree.watch ? {
      watch(scope: TreeWatchScope, opts?: TreeWatchOpts, ctx?: unknown): AsyncIterable<TreeEvent> {
        const inner = tree.watch!(scope, opts, ctx);
        async function* wrapped(): AsyncIterable<TreeEvent> {
          for await (const event of inner) {
            if (event.type === 'reconnect') {
              if (!event.preserved) wrapper.invalidateAll();
            } else {
              wrapper.invalidate(event.path);
            }
            yield event;
          }
        }
        return wrapped();
      },
    } : {}),
  };
  return wrapper;
}
