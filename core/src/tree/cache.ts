// Treenix Cache Tree — Layer 1
// Flat path-keyed FIFO cache wrapping any Tree.
// Populate on read AND write. Inflight dedup prevents thundering herd.

import type { NodeData } from '#core';
import { createBoundedCache } from '#util/bounded-cache';
import { type CommitReceipt, type PatchManyEntry, type Tree, type TreeEvent, type TreeWatchOpts, type TreeWatchScope } from './index';
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

  /** Fold a commit receipt into the cache (core-ns6p.2): epoch-bump FIRST so
   *  an in-flight get cannot overwrite the fresh image with a stale read (the
   *  old post-set reread had this race), then populate committed after-images.
   *  Opaque receipt (remote authority) → invalidate the verb's own paths. */
  function absorb(receipt: CommitReceipt, verbPaths: string[]): CommitReceipt {
    invalidateEpoch++;
    // null: opaque authority — images unknown. []: known no-op — but the
    // verb's own paths may hold stale phantoms (remove of a node the backing
    // lost out-of-band); the old unconditional invalidate evicted those.
    if (receipt.changes === null || receipt.changes.length === 0) {
      for (const p of verbPaths) cache.delete(p);
      return receipt;
    }
    for (const c of receipt.changes) {
      if (c.after) cache.set(c.path, c.after);
      else cache.delete(c.path);
    }
    return receipt;
  }

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
      return absorb(await tree.set(node, ctx), [node.$path]);
    },

    async remove(path, ctx) {
      return absorb(await tree.remove(path, ctx), [path]);
    },

    async patch(path, ops, ctx) {
      return patchViaSet(wrapper, path, ops, ctx);
    },

    // patchMany forwards NATIVELY (never per-member patchViaSet — that would
    // split the atomic batch into independent writes). Members absorb
    // (epoch-bumping) only AFTER the inner commit; a failed batch changed
    // nothing underneath, so the cache stays valid.
    ...(tree.patchMany ? {
      async patchMany(ancestor: string, entries: PatchManyEntry[], ctx?: unknown) {
        return absorb(await tree.patchMany!(ancestor, entries, ctx), entries.map(e => e.path));
      },
    } : {}),

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
