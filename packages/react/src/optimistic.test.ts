// Optimistic prediction tests — predictOptimistic runs action handlers on cached clones

import { registerType } from '@treenity/core/comp';
import { resolve } from '@treenity/core';
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import * as cache from './cache';
import { predictOptimistic } from './hooks';

class Counter {
  count = 0;

  increment() {
    this.count++;
  }

  setCount(data: { count: number }) {
    this.count = data.count;
  }

  async asyncAction() {
    await Promise.resolve();
    this.count = 999;
  }

  broken() {
    throw new Error('intentional failure');
  }
}

registerType('test.counter', Counter);

const actionFn = (name: string) => resolve('test.counter', `action:${name}`, false)!;

describe('predictOptimistic', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('sync method updates cache immediately', () => {
    cache.put({ $path: '/c', $type: 'test.counter', count: 5 } as any);

    predictOptimistic('/c', Counter, undefined, actionFn('increment'), undefined);

    const node = cache.get('/c');
    assert.strictEqual((node as any).count, 6);
  });

  it('sync method with data updates cache', () => {
    cache.put({ $path: '/c', $type: 'test.counter', count: 0 } as any);

    predictOptimistic('/c', Counter, undefined, actionFn('setCount'), { count: 42 });

    const node = cache.get('/c');
    assert.strictEqual((node as any).count, 42);
  });

  it('does not mutate original cached node', () => {
    cache.put({ $path: '/c', $type: 'test.counter', count: 10 } as any);
    const before = cache.get('/c');

    predictOptimistic('/c', Counter, undefined, actionFn('increment'), undefined);

    const after = cache.get('/c');
    assert.notStrictEqual(before, after);
  });

  it('swallows method errors without updating cache', () => {
    cache.put({ $path: '/c', $type: 'test.counter', count: 5 } as any);

    predictOptimistic('/c', Counter, undefined, actionFn('broken'), undefined);

    const node = cache.get('/c');
    assert.strictEqual((node as any).count, 5);
  });

  it('skips when path not in cache', () => {
    predictOptimistic('/missing', Counter, undefined, actionFn('increment'), undefined);

    assert.strictEqual(cache.get('/missing'), undefined);
  });

  it('skips when component type not found on node', () => {
    cache.put({ $path: '/c', $type: 'unknown.type', count: 5 } as any);

    predictOptimistic('/c', Counter, undefined, actionFn('increment'), undefined);

    const node = cache.get('/c');
    assert.strictEqual((node as any).count, 5);
  });

  it('works with named component key', () => {
    cache.put({
      $path: '/n',
      $type: 'dir',
      stats: { $type: 'test.counter', count: 3 },
    } as any);

    predictOptimistic('/n', Counter, 'stats', actionFn('increment'), undefined);

    const node = cache.get('/n') as any;
    assert.strictEqual(node.stats.count, 4);
  });

  it('noOptimistic actions are skipped by getMeta check', () => {
    // This tests the integration: noOptimistic flag in meta prevents prediction
    // predictOptimistic itself doesn't check meta — callers (execute, makeProxy) do
    // So we verify the action handler still throws when called directly (safety net)
    cache.put({ $path: '/c', $type: 'test.counter', count: 5 } as any);

    // asyncAction handler wraps an async method — calling it on draft will throw/be caught
    predictOptimistic('/c', Counter, undefined, actionFn('asyncAction'), undefined);

    const node = cache.get('/c');
    assert.strictEqual((node as any).count, 5); // unchanged
  });
});
