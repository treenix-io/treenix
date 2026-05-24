// withCache.watch — cache invalidation via watch events (Part D follow-up).
// Pins the federation-client semantics: data events evict the path before
// yielding; reconnect{preserved:false} clears the whole cache; reconnect
// {preserved:true} is a pure pass-through. When the inner tree exposes no
// watch, the wrapper omits watch (caller's TypeError surfaces the gap).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NodeData } from '#core';
import { createMemoryTree, type Tree, type TreeEvent } from '#tree';
import { withCache } from '#tree/cache';
import { withSubscriptions } from '#sub';

describe('withCache.watch — cache invalidation', () => {
  it('omits watch when inner does not expose it', () => {
    // createMemoryTree implements get/set/remove/patch/scanChildren but no watch.
    const cached = withCache(createMemoryTree());
    assert.equal(cached.watch, undefined, 'no watch when inner has no watch');
  });

  it('exposes watch when inner exposes it', () => {
    const { tree } = withSubscriptions(createMemoryTree());
    const cached = withCache(tree);
    assert.equal(typeof cached.watch, 'function');
  });

  it('set event evicts cached path before yielding to consumer', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    const cached = withCache(tree);

    // Warm cache
    await cached.set({ $path: '/a', $type: 't', v: 1 } as NodeData);
    const first = await cached.get('/a');
    assert.equal((first as { v: number } & NodeData).v, 1);

    // Start watching, then mutate via the INNER tree (cache stays stale until watch fires)
    const stream = cached.watch!({ kind: 'all' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    // Direct inner write — withCache.set was NOT called, so cache is stale
    await tree.set({ $path: '/a', $type: 't', v: 99 } as NodeData);

    const { value: event } = await pump;
    await it.return!();

    // After yielding the event, cache.get returns fresh from inner (no stale 1)
    const refetched = await cached.get('/a');
    assert.equal((refetched as { v: number } & NodeData).v, 99, 'cache evicted, re-fetched fresh');
    assert.ok(event && event.type !== 'reconnect');
  });

  it('remove event evicts the cached path', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    const cached = withCache(tree);

    await cached.set({ $path: '/x', $type: 't' } as NodeData);
    await cached.get('/x'); // warm

    const stream = cached.watch!({ kind: 'all' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    await tree.remove('/x');
    await pump;
    await it.return!();

    const after = await cached.get('/x');
    assert.equal(after, undefined, 'cache cleared, miss propagated');
  });

  it('reconnect{preserved:false} clears the cache', async () => {
    // Drive the wrapped iterable manually so we can synthesize a reconnect.
    let push: ((e: TreeEvent) => void) | null = null;
    const cleanups: (() => void)[] = [];

    const inner: Tree = {
      get: createMemoryTree().get,
      getChildren: createMemoryTree().getChildren,
      set: createMemoryTree().set,
      remove: createMemoryTree().remove,
      patch: createMemoryTree().patch,
      watch() {
        return {
          [Symbol.asyncIterator]() {
            let waiter: ((v: IteratorResult<TreeEvent>) => void) | null = null;
            const queue: TreeEvent[] = [];
            push = (e) => {
              if (waiter) { const w = waiter; waiter = null; w({ value: e, done: false }); }
              else queue.push(e);
            };
            return {
              async next() {
                if (queue.length) return { value: queue.shift()!, done: false };
                return new Promise<IteratorResult<TreeEvent>>(r => { waiter = r; });
              },
              async return() { return { value: undefined, done: true }; },
              [Symbol.asyncIterator]() { return this; },
            };
          },
        };
      },
    };

    const cached = withCache(inner);
    await cached.set({ $path: '/k', $type: 't', v: 'cached' } as NodeData);

    const stream = cached.watch!({ kind: 'all' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    push!({ type: 'reconnect', preserved: false });
    await pump;

    // After reconnect{preserved:false}: cache cleared, get must miss
    // (we can't easily prove "miss" without a counter — verify by overwriting
    // inner store under the hood and confirming we see the new value)
    const cleanup = await it.return!();
    cleanups.push(() => cleanup);

    // The cache was cleared — verify by setting a new value via inner and
    // observing the cached.get re-reads through.
    const fresh = await cached.get('/k');
    assert.equal(fresh, undefined, 'cache cleared by reconnect{preserved:false}');
  });

  it('reconnect{preserved:true} does NOT clear the cache', async () => {
    let push: ((e: TreeEvent) => void) | null = null;

    const inner: Tree = {
      ...createMemoryTree(),
      watch() {
        return {
          [Symbol.asyncIterator]() {
            let waiter: ((v: IteratorResult<TreeEvent>) => void) | null = null;
            const queue: TreeEvent[] = [];
            push = (e) => {
              if (waiter) { const w = waiter; waiter = null; w({ value: e, done: false }); }
              else queue.push(e);
            };
            return {
              async next() {
                if (queue.length) return { value: queue.shift()!, done: false };
                return new Promise<IteratorResult<TreeEvent>>(r => { waiter = r; });
              },
              async return() { return { value: undefined, done: true }; },
              [Symbol.asyncIterator]() { return this; },
            };
          },
        };
      },
    };

    const cached = withCache(inner);
    await cached.set({ $path: '/k', $type: 't', v: 'cached' } as NodeData);

    const stream = cached.watch!({ kind: 'all' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    push!({ type: 'reconnect', preserved: true });
    await pump;
    await it.return!();

    // preserved:true → cache untouched
    const fresh = await cached.get('/k');
    assert.ok(fresh, 'cache survives preserved reconnect');
  });
});
