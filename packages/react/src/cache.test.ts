// Cache contract tests — plain Map implementation

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import * as cache from './cache';

describe('cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('put() creates entry, get() returns node', () => {
    cache.put({ $path: '/a', $type: 'x', v: 1 } as any);
    const n = cache.get('/a');
    assert.ok(n);
    assert.strictEqual(n!.v, 1);
  });

  it('second put() updates value', () => {
    cache.put({ $path: '/a', $type: 'x', v: 1 } as any);
    cache.put({ $path: '/a', $type: 'x', v: 2 } as any);
    const n = cache.get('/a');
    assert.strictEqual(n!.v, 2);
  });

  it('put() with fewer keys replaces node', () => {
    cache.put({ $path: '/a', $type: 'x', old: 1, keep: 2 } as any);
    cache.put({ $path: '/a', $type: 'x', keep: 3 } as any);
    const n = cache.get('/a') as any;
    assert.strictEqual(n.keep, 3);
    assert.strictEqual('old' in n, false);
  });

  it('subscribePath fires on put()', () => {
    let called = 0;
    cache.subscribePath('/a', () => called++);
    cache.put({ $path: '/a', $type: 'x' } as any);
    assert.strictEqual(called, 1);
  });

  it('subscribeChildren fires on child put()', () => {
    let called = 0;
    cache.subscribeChildren('/', () => called++);
    cache.put({ $path: '/child', $type: 'x' } as any);
    assert.ok(called >= 1);
  });

  it('getSnapshot() returns plain cloneable object', () => {
    cache.put({ $path: '/a', $type: 'x', v: 42 } as any);
    const s = cache.getSnapshot('/a');
    assert.ok(s);
    assert.strictEqual(s!.v, 42);
    const cloned = structuredClone(s);
    assert.strictEqual(cloned.v, 42);
  });

  it('getSnapshot() returns a copy, not the same reference', () => {
    cache.put({ $path: '/a', $type: 'x', v: 42 } as any);
    const s = cache.getSnapshot('/a');
    assert.notStrictEqual(s, cache.get('/a'));
  });

  it('notifyPath fires path subs', () => {
    cache.put({ $path: '/a', $type: 'x' } as any);
    let called = 0;
    cache.subscribePath('/a', () => called++);
    cache.notifyPath('/a');
    assert.strictEqual(called, 1);
  });

  it('getChildren returns sorted children', () => {
    cache.put({ $path: '/b', $type: 'x' } as any);
    cache.put({ $path: '/a', $type: 'x' } as any);
    const kids = cache.getChildren('/');
    assert.strictEqual(kids.length, 2);
    assert.strictEqual(kids[0].$path, '/a');
    assert.strictEqual(kids[1].$path, '/b');
  });

  it('remove() deletes node and fires subs', () => {
    cache.put({ $path: '/a', $type: 'x' } as any);
    let called = 0;
    cache.subscribePath('/a', () => called++);
    cache.remove('/a');
    assert.strictEqual(cache.get('/a'), undefined);
    assert.strictEqual(called, 1);
  });

  it('putMany() stores all nodes, fires subs', () => {
    let parentFired = 0;
    cache.subscribeChildren('/p', () => parentFired++);
    cache.putMany([
      { $path: '/p/a', $type: 'x' } as any,
      { $path: '/p/b', $type: 'x' } as any,
    ], '/p');
    assert.ok(cache.get('/p/a'));
    assert.ok(cache.get('/p/b'));
    assert.ok(parentFired >= 1);
  });

  it('direct mutation of get() result changes cached value', () => {
    cache.put({ $path: '/a', $type: 'x', v: 1 } as any);
    const n = cache.get('/a') as any;
    n.v = 99;
    assert.strictEqual(cache.get('/a')!.v, 99);
  });

  it('onNodePut callback fires on every put()', () => {
    const paths: string[] = [];
    cache.onNodePut((p) => paths.push(p));
    cache.put({ $path: '/a', $type: 'x' } as any);
    cache.put({ $path: '/b', $type: 'x' } as any);
    assert.deepStrictEqual(paths, ['/a', '/b']);
  });

  it('nested component update works', () => {
    cache.put({ $path: '/a', $type: 'x', comp: { $type: 'y', count: 0, label: 'hi' } } as any);
    cache.put({ $path: '/a', $type: 'x', comp: { $type: 'y', count: 5, label: 'hi' } } as any);
    assert.strictEqual((cache.get('/a') as any).comp.count, 5);
  });

  it('adding a new nested component', () => {
    cache.put({ $path: '/a', $type: 'x' } as any);
    cache.put({ $path: '/a', $type: 'x', comp: { $type: 'y', v: 1 } } as any);
    assert.strictEqual((cache.get('/a') as any).comp.v, 1);
  });

  it('removing a nested component', () => {
    cache.put({ $path: '/a', $type: 'x', comp: { $type: 'y', v: 1 } } as any);
    cache.put({ $path: '/a', $type: 'x' } as any);
    assert.strictEqual('comp' in (cache.get('/a') as any), false);
  });

  it('array replaced wholesale', () => {
    cache.put({ $path: '/a', $type: 'x', items: [1, 2, 3] } as any);
    cache.put({ $path: '/a', $type: 'x', items: [4, 5] } as any);
    assert.deepStrictEqual([...(cache.get('/a') as any).items], [4, 5]);
  });
});
