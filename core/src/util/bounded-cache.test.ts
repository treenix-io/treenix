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
