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

  it('replaceChildren() stores all nodes, fires subs', () => {
    let parentFired = 0;
    cache.subscribeChildren('/p', () => parentFired++);
    cache.replaceChildren('/p', [
      { $path: '/p/a', $type: 'x' } as any,
      { $path: '/p/b', $type: 'x' } as any,
    ]);
    assert.ok(cache.get('/p/a'));
    assert.ok(cache.get('/p/b'));
    assert.ok(parentFired >= 1);
  });

  it('replaceChildren() unlinks removed children from parent index', () => {
    cache.replaceChildren('/p', [
      { $path: '/p/a', $type: 'x' } as any,
      { $path: '/p/b', $type: 'x' } as any,
    ]);
    cache.replaceChildren('/p', [
      { $path: '/p/a', $type: 'x' } as any,
      // /p/b removed
    ]);
    const kids = cache.getChildren('/p');
    assert.strictEqual(kids.length, 1);
    assert.strictEqual(kids[0].$path, '/p/a');
    // Soft cache: removed node stays accessible via direct get
    assert.ok(cache.get('/p/b'));
  });

  it('replaceChildren() marks parent as authoritatively loaded', () => {
    assert.strictEqual(cache.hasChildrenCollectionLoaded('/p'), false);
    cache.replaceChildren('/p', []);
    assert.strictEqual(cache.hasChildrenCollectionLoaded('/p'), true);
  });

  it('hydrateFromServerSnapshot seeds paths and authoritative children', () => {
    cache.hydrateFromServerSnapshot({
      paths: {
        '/page': { $path: '/page', $type: 'page', title: 'SSR' },
        '/missing': null,
      },
      children: {
        '/sys/routes': [
          { $path: '/sys/routes/index', $type: 'route', route: '/' },
        ],
      },
      childMeta: {
        '/sys/routes': { total: 3, truncated: true },
      },
    });

    assert.strictEqual(cache.get('/page')?.title, 'SSR');
    assert.strictEqual(cache.getPathStatus('/page'), 'ready');
    assert.strictEqual(cache.getPathStatus('/missing'), 'not_found');
    assert.strictEqual(cache.getChildren('/sys/routes').length, 1);
    assert.strictEqual(cache.hasChildrenCollectionLoaded('/sys/routes'), true);
    assert.strictEqual(cache.getChildrenPhase('/sys/routes'), 'ready');
    assert.strictEqual(cache.getChildrenTotal('/sys/routes'), 3);
    assert.strictEqual(cache.getChildrenTruncated('/sys/routes'), true);
  });

  it('appendChildren() merges without removing existing', () => {
    cache.replaceChildren('/p', [{ $path: '/p/a', $type: 'x' } as any]);
    cache.appendChildren('/p', [{ $path: '/p/b', $type: 'x' } as any]);
    const kids = cache.getChildren('/p');
    assert.strictEqual(kids.length, 2);
  });

  it('put() does NOT mark parent as authoritatively loaded', () => {
    cache.put({ $path: '/a/child', $type: 'x' } as any);
    assert.strictEqual(cache.hasChildrenCollectionLoaded('/a'), false);
  });

  it('hydrate pathStatus: put() sets ready, markPathMissing sets not_found', () => {
    assert.strictEqual(cache.getPathStatus('/a'), undefined);
    cache.put({ $path: '/a', $type: 'x' } as any);
    assert.strictEqual(cache.getPathStatus('/a'), 'ready');
    cache.markPathMissing('/a');
    assert.strictEqual(cache.getPathStatus('/a'), 'not_found');
    assert.strictEqual(cache.get('/a'), undefined);
  });

  it('markPathMissing fires both path and path-error subs', () => {
    cache.put({ $path: '/a', $type: 'x' } as any);
    let pathFired = 0;
    let errFired = 0;
    cache.subscribePath('/a', () => pathFired++);
    cache.subscribePathError('/a', () => errFired++);
    cache.markPathMissing('/a');
    assert.ok(pathFired >= 1);
    assert.ok(errFired >= 1);
  });

  it('setPathError sets and clears error, fires error subs', () => {
    let errFired = 0;
    cache.subscribePathError('/a', () => errFired++);
    cache.setPathError('/a', new Error('boom'));
    assert.ok(cache.getPathError('/a'));
    assert.strictEqual(errFired, 1);
    cache.setPathError('/a', null);
    assert.strictEqual(cache.getPathError('/a'), null);
    assert.strictEqual(errFired, 2);
  });

  it('put() clears prior path error', () => {
    cache.setPathError('/a', new Error('boom'));
    cache.put({ $path: '/a', $type: 'x' } as any);
    assert.strictEqual(cache.getPathError('/a'), null);
  });

  it('children phase transitions', () => {
    assert.strictEqual(cache.getChildrenPhase('/p'), 'idle');
    cache.setChildrenPhase('/p', 'initial');
    assert.strictEqual(cache.getChildrenPhase('/p'), 'initial');
    cache.setChildrenPhase('/p', 'ready');
    assert.strictEqual(cache.getChildrenPhase('/p'), 'ready');
  });

  it('childPageSize first-wins lock', () => {
    const first = cache.lockChildPageSize('/p', 10);
    assert.strictEqual(first, 10);
    const second = cache.lockChildPageSize('/p', 50);
    assert.strictEqual(second, 10);
    assert.strictEqual(cache.getChildPageSize('/p'), 10);
  });

  it('subscriber ref-count releases page size on last unmount', () => {
    cache.retainChildSubscriber('/p');
    cache.retainChildSubscriber('/p');
    cache.lockChildPageSize('/p', 25);
    cache.releaseChildSubscriber('/p');
    assert.strictEqual(cache.getChildPageSize('/p'), 25);  // still locked
    cache.releaseChildSubscriber('/p');
    assert.strictEqual(cache.getChildPageSize('/p'), undefined);  // released
    // New subscriber can re-lock with a different value
    const next = cache.lockChildPageSize('/p', 77);
    assert.strictEqual(next, 77);
  });

  it('loadedCount clamps to items.length on replaceChildren', () => {
    cache.replaceChildren('/p', [
      { $path: '/p/a', $type: 'x' } as any,
      { $path: '/p/b', $type: 'x' } as any,
      { $path: '/p/c', $type: 'x' } as any,
    ]);
    assert.strictEqual(cache.getLoadedCount('/p'), 3);
    // Server returns fewer — loadedCount shrinks
    cache.replaceChildren('/p', [{ $path: '/p/a', $type: 'x' } as any]);
    assert.strictEqual(cache.getLoadedCount('/p'), 1);
  });

  it('appendChildren increments loadedCount by new items only (dedupes)', () => {
    cache.replaceChildren('/p', [{ $path: '/p/a', $type: 'x' } as any]);
    assert.strictEqual(cache.getLoadedCount('/p'), 1);
    cache.appendChildren('/p', [
      { $path: '/p/a', $type: 'x' } as any,  // duplicate
      { $path: '/p/b', $type: 'x' } as any,
    ]);
    assert.strictEqual(cache.getLoadedCount('/p'), 2);
  });

  it('signalReconnect clears fetch state but preserves subscribers', () => {
    cache.retainChildSubscriber('/p');
    cache.replaceChildren('/p', [{ $path: '/p/a', $type: 'x' } as any]);
    cache.setChildrenTotal('/p', 42);
    cache.setChildrenPhase('/p', 'ready');
    cache.put({ $path: '/x', $type: 'y' } as any);
    cache.signalReconnect();
    assert.strictEqual(cache.hasChildrenCollectionLoaded('/p'), false);
    assert.strictEqual(cache.getChildrenTotal('/p'), null);
    assert.strictEqual(cache.getChildrenPhase('/p'), 'idle');
    assert.strictEqual(cache.getPathStatus('/x'), undefined);
    // Soft cache node data stays — hooks revalidate via gen bump
    assert.ok(cache.get('/x'));
    cache.releaseChildSubscriber('/p');
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

  // Regression: node lives under /data naturally AND virtual parent /vp via addToParent.
  // An in-place put() (result of rebase, patch application, or stayVps routing)
  // must fire childSubs for BOTH parents, not just the natural one.
  it('put() notifies all virtual parents a node is linked to', () => {
    cache.put({ $path: '/data/x', $type: 'task', v: 1 } as any);
    cache.addToParent('/data/x', '/vp');

    let vpCalls = 0;
    let dataCalls = 0;
    cache.subscribeChildren('/vp', () => vpCalls++);
    cache.subscribeChildren('/data', () => dataCalls++);

    cache.put({ $path: '/data/x', $type: 'task', v: 2 } as any);

    assert.ok(vpCalls >= 1, '/vp childSubs must fire on in-place update');
    assert.ok(dataCalls >= 1, '/data childSubs must fire too');
  });

  it('remove() unlinks node from every parent that listed it', () => {
    cache.put({ $path: '/data/x', $type: 'task' } as any);
    cache.addToParent('/data/x', '/vp');

    let vpCalls = 0;
    cache.subscribeChildren('/vp', () => vpCalls++);

    cache.remove('/data/x');

    assert.ok(vpCalls >= 1, '/vp childSubs must fire on remove');
    assert.strictEqual(cache.getChildren('/vp').length, 0, '/vp must no longer list removed node');
  });
});
