// Door-level pins (ns6p.4 r2-F1): the tracked-read door orders ABSENCE, which
// ingest alone cannot — remove-vs-node and create-vs-absent are driven here
// with the same cache primitives the event lane uses (evictTracked = the F2
// eviction; put+flag = a create event).

import type { NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as cache from './cache';
import { cancelReadReconverges, evictTracked, trackedGet, trackedList } from './read-track';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const node = (path: string, rev?: number, v?: string): NodeData =>
  rev === undefined ? { $path: path, $type: 'doc', v } : { $path: path, $type: 'doc', $rev: rev, v };

/** Event-driven wait on a single path's cache state. */
function waitPath(path: string, pred: () => boolean): Promise<void> {
  return new Promise((resolvePromise) => {
    const check = () => { if (pred()) { unsub(); resolvePromise(); } };
    const unsub = cache.subscribePath(path, check);
    check();
  });
}

const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => cache.clear());
afterEach(() => cancelReadReconverges());

describe('read-track door — remove-vs-node (r2-F1/F2)', () => {
  it('eviction during an in-flight get: the older node response is NOT applied — no resurrection, reconverge heals', async () => {
    const d = deferred<NodeData | null>();
    const fetches: number[] = [];
    const fetch = () => {
      fetches.push(fetches.length);
      return fetches.length === 1 ? d.promise : Promise.resolve(null);
    };
    const p = trackedGet('/rx', fetch);

    // The F2 lane evicts mid-flight (remove event / FORBIDDEN refetch).
    evictTracked('/rx');

    d.resolve(node('/rx', 1, 'zombie'));
    const o = await p;

    assert.equal(o.applied, true);
    assert.equal(o.overlapped, true);
    assert.equal(cache.get('/rx'), undefined, 'stale response must never re-enter the cache after the evict');

    // Default reconverge lane re-runs the fetch and settles the truth.
    await waitPath('/rx', () => cache.getPathStatus('/rx') === 'not_found');
    assert.equal(fetches.length, 2);
    assert.equal(cache.get('/rx'), undefined);
  });

  it('a still-cached node overlapped by a data event ingests non-regressing (apply, then reconverge)', async () => {
    const d = deferred<NodeData | null>();
    const p = trackedGet('/nx', () => d.promise, { onOverlap: () => {} });

    // Event lane: newer image + overlap flag (what applyDataEvent does).
    cache.flagPathReadOverlap('/nx');
    cache.put(node('/nx', 5, 'fresh'));

    d.resolve(node('/nx', 1, 'stale'));
    const o = await p;

    assert.equal(o.overlapped, true);
    assert.equal(cache.get('/nx')?.$rev, 5, 'ingest kept the newer image');
  });
});

describe('read-track door — create-vs-absent (r2-F1)', () => {
  it('an overlapped absent response never markPathMissing — the created node survives, reconverge decides', async () => {
    const d = deferred<NodeData | null>();
    const fetches: number[] = [];
    const fetch = () => {
      fetches.push(fetches.length);
      return fetches.length === 1 ? d.promise : Promise.resolve(node('/cx', 1, 'born'));
    };
    const p = trackedGet('/cx', fetch);

    // Create event lands mid-read.
    cache.flagPathReadOverlap('/cx');
    cache.put(node('/cx', 1, 'born'));

    d.resolve(null);
    const o = await p;

    assert.equal(o.overlapped, true);
    assert.ok(cache.get('/cx'), 'older absent response must not delete the created node');
    assert.notEqual(cache.getPathStatus('/cx'), 'not_found');

    await waitPath('/cx', () => fetches.length === 2 && cache.getPathStatus('/cx') === 'ready');
  });

  it('an unoverlapped absent response IS authoritative — markPathMissing', async () => {
    cache.put(node('/gone', 1, 'old'));
    const o = await trackedGet('/gone', async () => null);
    assert.equal(o.applied, true);
    assert.equal(cache.get('/gone'), undefined);
    assert.equal(cache.getPathStatus('/gone'), 'not_found');
  });
});

describe('read-track door — cross-consumer generations (invariant 17)', () => {
  it('two consumers on one path: the older response settling LAST is dropped', async () => {
    const d1 = deferred<NodeData | null>();
    const p1 = trackedGet('/g', () => d1.promise); // consumer A (e.g. a mount)
    const p2 = trackedGet('/g', async () => node('/g', 2, 'newer')); // consumer B supersedes

    const o2 = await p2;
    assert.equal(o2.applied, true);

    d1.resolve(node('/g', 9, 'late-but-superseded'));
    const o1 = await p1;

    assert.equal(o1.applied, false, 'latest-issued wins, never last-settled');
    assert.equal(o1.current, false);
    assert.equal((cache.get('/g') as { v?: string }).v, 'newer');
  });

  it('a superseded read that FAILS surfaces error with current:false — callers must not clobber the winner', async () => {
    const d1 = deferred<NodeData | null>();
    const p1 = trackedGet('/e', () => d1.promise);
    await trackedGet('/e', async () => node('/e', 1, 'ok'));

    d1.reject(new Error('boom'));
    const o1 = await p1;

    assert.equal(o1.applied, false);
    assert.equal(o1.current, false);
    assert.ok(o1.error instanceof Error);
    assert.equal((cache.get('/e') as { v?: string }).v, 'ok');
  });

  it('a CURRENT failing read surfaces error with current:true and writes nothing', async () => {
    cache.put(node('/f', 1, 'kept'));
    const o = await trackedGet('/f', async () => { throw new Error('down'); });
    assert.equal(o.applied, false);
    assert.equal(o.current, true);
    assert.ok(o.error instanceof Error);
    assert.equal((cache.get('/f') as { v?: string }).v, 'kept');
  });
});

describe('read-track door — trackedList', () => {
  it('items ingest before apply: a page carrying an older image cannot regress the cached node', async () => {
    cache.put(node('/l/a', 5, 'fresh'));
    let applied: NodeData[] = [];
    const o = await trackedList('/l', undefined,
      async () => ({ items: [node('/l/a', 1, 'stale')] }),
      (r) => { applied = r.items; cache.replaceChildren('/l', r.items); });

    assert.equal(o.applied, true);
    assert.equal(applied[0].$rev, 5, 'apply received the kept (ingested) image');
    assert.equal(cache.get('/l/a')?.$rev, 5);
  });

  it('membership overlap: default reconverge lane re-runs the same listing once, coalesced', async () => {
    const d = deferred<{ items: NodeData[] }>();
    const fetches: number[] = [];
    const fetch = () => {
      fetches.push(fetches.length);
      return fetches.length === 1 ? d.promise : Promise.resolve({ items: [node('/m/a'), node('/m/new')] });
    };
    const applies: string[][] = [];
    const p = trackedList('/m', undefined, fetch,
      (r) => { applies.push(r.items.map((n) => n.$path)); cache.replaceChildren('/m', r.items); });

    cache.flagChildrenReadOverlap('/m'); // create event mid-read

    d.resolve({ items: [node('/m/a')] });
    const o = await p;
    assert.equal(o.overlapped, true);
    assert.deepEqual(applies, [['/m/a']], 'stale page authoritative for the moment');

    await new Promise<void>((res) => {
      const unsub = cache.subscribeChildren('/m', () => {
        if (applies.length === 2) { unsub(); res(); }
      });
      if (applies.length === 2) { unsub(); res(); }
    });
    assert.deepEqual(applies[1], ['/m/a', '/m/new'], 'reconverge brought the created child');
  });

  it('stale list response is dropped without touching the cache', async () => {
    const d = deferred<{ items: NodeData[] }>();
    const p1 = trackedList('/s', undefined, () => d.promise, (r) => cache.replaceChildren('/s', r.items));
    await trackedList('/s', undefined, async () => ({ items: [node('/s/new')] }), (r) => cache.replaceChildren('/s', r.items));

    d.resolve({ items: [node('/s/old')] });
    const o1 = await p1;
    await flush();

    assert.equal(o1.applied, false);
    assert.deepEqual(cache.getChildren('/s').map((n) => n.$path), ['/s/new']);
  });
});
