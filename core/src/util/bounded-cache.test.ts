import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBoundedCache } from './bounded-cache';

describe('createBoundedCache', () => {
  it('evicts the oldest entry when maxItems is reached', () => {
    const cache = createBoundedCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('c'), 3);
  });

  it('refreshes an existing key on set', () => {
    const cache = createBoundedCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);

    assert.equal(cache.get('a'), 10);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('c'), 3);
  });

  it('deletes entries by predicate', () => {
    const cache = createBoundedCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    const deleted = cache.deleteWhere((v) => v % 2 === 1);

    assert.equal(deleted, 2);
    assert.equal(cache.size, 1);
    assert.deepEqual([...cache.entries()], [['b', 2]]);
  });

  it('rejects non-positive maxItems', () => {
    assert.throws(() => createBoundedCache(0), /positive integer/);
  });
});

// onEvict — callback fires whenever an entry leaves the cache. Used by
// withMounts to release external-watch consumers, so a FIFO drop doesn't
// silently leak change-stream cursors + timers + onSelfWrite subscriptions.

describe('createBoundedCache — onEvict callback', () => {
  it('fires on FIFO eviction when cache fills up', () => {
    const evicted: Array<[string, number]> = [];
    const cache = createBoundedCache<string, number>(2, {
      onEvict: (v, k) => evicted.push([k, v]),
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    assert.deepEqual(evicted, [['a', 1]]);
  });

  it('fires on explicit delete', () => {
    const evicted: number[] = [];
    const cache = createBoundedCache<string, number>(10, {
      onEvict: (v) => evicted.push(v),
    });
    cache.set('a', 7);
    assert.equal(cache.delete('a'), true);
    assert.deepEqual(evicted, [7]);
  });

  it('does NOT fire when delete misses', () => {
    let fired = 0;
    const cache = createBoundedCache<string, number>(10, {
      onEvict: () => { fired++; },
    });
    assert.equal(cache.delete('missing'), false);
    assert.equal(fired, 0);
  });

  it('fires for every matching entry on deleteWhere', () => {
    const evicted: number[] = [];
    const cache = createBoundedCache<string, number>(10, {
      onEvict: (v) => evicted.push(v),
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.deleteWhere((v) => v % 2 === 1);
    assert.deepEqual(evicted.sort(), [1, 3]);
  });

  it('fires for every entry on clear()', () => {
    const evicted: number[] = [];
    const cache = createBoundedCache<string, number>(10, {
      onEvict: (v) => evicted.push(v),
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.deepEqual(evicted.sort(), [1, 2]);
    assert.equal(cache.size, 0);
  });

  it('fires on replacement (set of an existing key)', () => {
    const evicted: number[] = [];
    const cache = createBoundedCache<string, number>(10, {
      onEvict: (v) => evicted.push(v),
    });
    cache.set('a', 1);
    cache.set('a', 2); // replace — previous value released
    assert.deepEqual(evicted, [1]);
  });

  it('isolates exceptions: a throwing onEvict does not abort the cache operation', () => {
    const origErr = console.error;
    let errored = false;
    console.error = () => { errored = true; };
    try {
      const cache = createBoundedCache<string, number>(1, {
        onEvict: () => { throw new Error('listener bug'); },
      });
      cache.set('a', 1);
      // Triggers eviction → onEvict throws → must not propagate
      cache.set('b', 2);
      assert.equal(cache.size, 1, 'cache still functional');
      assert.ok(errored, 'error logged, not silenced');
    } finally {
      console.error = origErr;
    }
  });
});
