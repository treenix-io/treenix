// Client read ordering (ns6p.4 §3.3, slice 3): request generations per
// resource, resource-overlap → reconverge refetch, and non-regressing
// rebase-aware snapshot ingest — exercised through ClientTreeSource with a
// deferred-capable transport so response ORDER is controlled by the test.

import { registerType } from '@treenx/core/comp';
import { resolve, type NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

type WirePage = { items: NodeData[]; total: number; truncated?: boolean; nextCursor?: string };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Scripted responses consumed in call order; a value may be a pending promise
// so the test decides WHEN (and in what order) responses settle.
const childrenPages: (WirePage | Promise<WirePage>)[] = [];
const getChildrenCalls: Record<string, unknown>[] = [];
const getChildrenQuery = mock.fn(async (input: Record<string, unknown>) => {
  getChildrenCalls.push(input);
  const page = childrenPages.shift();
  if (!page) throw new Error('getChildren called with no scripted page');
  return page;
});

const getResults: (NodeData | null | Promise<NodeData | null>)[] = [];
const getQuery = mock.fn(async (_input: Record<string, unknown>) => {
  const n = getResults.shift();
  if (n === undefined) throw new Error('get called with no scripted node');
  return n;
});

// Mock the trpc singleton before importing the source — same resolved URL
// serves '#tree/trpc' and './trpc', so one mock covers all importers.
mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: getQuery },
      getChildren: { query: getChildrenQuery },
      patch: { mutate: async () => {} },
      set: { mutate: async () => {} },
      remove: { mutate: async () => {} },
      execute: { mutate: async () => undefined },
      unwatch: { mutate: async () => {} },
      unwatchChildren: { mutate: async () => {} },
    },
    getToken: () => null,
    setToken: () => {},
    clearToken: () => {},
    AUTH_EXPIRED_EVENT: 'trpc:auth-expired',
    TAB_TOKEN: 'test-tab',
    tabTokenInput: { token: 'test-tab' },
  },
});

const { createClientTreeSource } = await import('./client-tree-source');
const cache = await import('#tree/cache');
const { applyDataEvent, stopEvents } = await import('./events');
const { clear: clearRebase, hasPending, pushOptimistic } = await import('./rebase');

class Counter {
  count = 0;
  increment() { this.count++; }
}
registerType('test.ro.counter', Counter);
const incrementAction = resolve('test.ro.counter', 'action:increment', false)!;

const node = (path: string, rev?: number, v?: string): NodeData =>
  rev === undefined ? { $path: path, $type: 'doc', v } : { $path: path, $type: 'doc', $rev: rev, v };
const vOf = (p: string) => (cache.get(p) as { v?: string } | undefined)?.v;
const countOf = (p: string) => (cache.get(p) as { count?: number } | undefined)?.count;
const members = (parent: string) => cache.getChildren(parent).map(n => n.$path);

/** Event-driven wait: resolves when `pred` holds after any children change. */
function waitChildren(parent: string, pred: () => boolean): Promise<void> {
  return new Promise((resolvePromise) => {
    const check = () => { if (pred()) { unsub(); resolvePromise(); } };
    const unsub = cache.subscribeChildren(parent, check);
    check();
  });
}

/** Event-driven wait on a single path's cache state. */
function waitPath(path: string, pred: () => boolean): Promise<void> {
  return new Promise((resolvePromise) => {
    const check = () => { if (pred()) { unsub(); resolvePromise(); } };
    const unsub = cache.subscribePath(path, check);
    check();
  });
}

const ready = (parent: string) => () => cache.getChildrenPhase(parent) === 'ready';

/** Drain microtasks after a deferred settles — a DROPPED response emits no
 *  cache event to wait on, so the absence of change is asserted after a flush. */
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  cache.clear();
  clearRebase();
  childrenPages.length = 0;
  getChildrenCalls.length = 0;
  getResults.length = 0;
});

afterEach(() => { stopEvents(); mock.restoreAll(); });

describe('read ordering — request generations (invariant 17)', () => {
  it('two overlapping reads of one resource: the older response settling LAST is dropped', async () => {
    const d1 = deferred<WirePage>();
    const d2 = deferred<WirePage>();
    childrenPages.push(d1.promise, d2.promise);
    const source = createClientTreeSource();
    const h = source.mountChildren('/gen', { limit: 10 });
    h.refetch();

    d2.resolve({ items: [node('/gen/new')], total: 1, nextCursor: 'c2' });
    await waitChildren('/gen', ready('/gen'));
    assert.deepEqual(members('/gen'), ['/gen/new']);

    d1.resolve({ items: [node('/gen/old')], total: 9, nextCursor: 'c1' });
    await flush();

    assert.deepEqual(members('/gen'), ['/gen/new'], 'stale response dropped, not last-settled-wins');
    assert.equal(source.getChildrenSnapshot('/gen').total, 1);
    assert.equal(source.getChildrenSnapshot('/gen').nextCursor, 'c2');
    h.dispose();
  });

  it('stale loadMore page (superseded by a refetch) is dropped, not appended (invariant 19)', async () => {
    childrenPages.push({ items: [node('/lm/a')], total: 1, nextCursor: 'c1' });
    const source = createClientTreeSource();
    const h = source.mountChildren('/lm', { limit: 1 });
    await waitChildren('/lm', ready('/lm'));

    const dm = deferred<WirePage>();
    const dr = deferred<WirePage>();
    childrenPages.push(dm.promise, dr.promise);
    h.loadMore();
    h.refetch();

    dm.resolve({ items: [node('/lm/b')], total: 1, nextCursor: 'c2' });
    await flush();
    assert.ok(!members('/lm').includes('/lm/b'), 'superseded page must not corrupt the fresh window');

    dr.resolve({ items: [node('/lm/a')], total: 1, nextCursor: 'c3' });
    await waitChildren('/lm', ready('/lm'));
    assert.deepEqual(members('/lm'), ['/lm/a']);
    assert.equal(source.getChildrenSnapshot('/lm').nextCursor, 'c3');
    h.dispose();
  });
});

describe('read ordering — resource overlap → reconverge refetch (§3.3-3)', () => {
  it('create event during an in-flight ls: the applying page schedules a coalesced refetch', async () => {
    const d1 = deferred<WirePage>();
    childrenPages.push(d1.promise, { items: [node('/o/a'), node('/o/new', 1)], total: 2 });
    const source = createClientTreeSource();
    const h = source.mountChildren('/o', { limit: 10 });

    // Mid-flight create (uncached set) — membership rev can't order this.
    applyDataEvent({ type: 'set', path: '/o/new', node: { $type: 'doc', $rev: 1 } });
    assert.ok(members('/o').includes('/o/new'), 'event-applied membership');

    // The page was computed server-side BEFORE the create — it drops the child.
    d1.resolve({ items: [node('/o/a')], total: 1 });
    await waitChildren('/o', ready('/o'));
    assert.ok(!members('/o').includes('/o/new'), 'stale page is authoritative for the moment');

    // Coalesced reconverge brings it back.
    await waitChildren('/o', () =>
      getChildrenCalls.length === 2 && cache.getChildrenPhase('/o') === 'ready'
      && members('/o').includes('/o/new'));
    h.dispose();
  });

  it('remove event during an in-flight refetch: stale page re-adds, reconverge refetch heals', async () => {
    childrenPages.push({ items: [node('/r/a'), node('/r/b')], total: 2 });
    const source = createClientTreeSource();
    const h = source.mountChildren('/r', { limit: 10 });
    await waitChildren('/r', ready('/r'));

    const d2 = deferred<WirePage>();
    childrenPages.push(d2.promise, { items: [node('/r/a')], total: 1 });
    h.refetch();

    applyDataEvent({ type: 'remove', path: '/r/b' });
    assert.ok(!members('/r').includes('/r/b'));

    d2.resolve({ items: [node('/r/a'), node('/r/b')], total: 2 });
    await waitChildren('/r', () => getChildrenCalls.length === 2 && cache.getChildrenPhase('/r') === 'ready');
    assert.ok(members('/r').includes('/r/b'), 'stale page re-added the removed child');

    await waitChildren('/r', () =>
      getChildrenCalls.length === 3 && cache.getChildrenPhase('/r') === 'ready'
      && !members('/r').includes('/r/b'));
    h.dispose();
  });
});

describe('read ordering — non-regressing snapshot ingest (invariants 18/28)', () => {
  it('page carrying an older image of one node does not regress it while other nodes update', async () => {
    childrenPages.push({ items: [node('/p/a', 1, 'a1'), node('/p/b', 1, 'b1')], total: 2 });
    const source = createClientTreeSource();
    const h = source.mountChildren('/p', { limit: 10 });
    await waitChildren('/p', ready('/p'));

    // Event advances /p/a past what the next (already-computed) page carries.
    applyDataEvent({ type: 'set', path: '/p/a', node: { $type: 'doc', $rev: 3, v: 'a3' } });
    assert.equal(vOf('/p/a'), 'a3');

    childrenPages.push({ items: [node('/p/a', 2, 'a2'), node('/p/b', 5, 'b5')], total: 2 });
    h.refetch();
    await waitChildren('/p', () => getChildrenCalls.length === 2 && cache.getChildrenPhase('/p') === 'ready');

    assert.equal(vOf('/p/a'), 'a3', 'newer event image kept (per-node, not per-page)');
    assert.equal(cache.get('/p/a')?.$rev, 3);
    assert.equal(vOf('/p/b'), 'b5', 'other nodes still update from the same page');
    assert.deepEqual(members('/p'), ['/p/a', '/p/b']);
    h.dispose();
  });

  it('exact get: response older than a mid-flight event does not regress the node', async () => {
    const dg = deferred<NodeData | null>();
    getResults.push(dg.promise);
    const source = createClientTreeSource();
    const h = source.mountPath('/x');

    applyDataEvent({ type: 'set', path: '/x', node: { $type: 'doc', $rev: 2, v: 'fresh' } });

    dg.resolve(node('/x', 1, 'stale'));
    await flush();

    assert.equal(vOf('/x'), 'fresh');
    assert.equal(cache.get('/x')?.$rev, 2);
    h.dispose();
  });

  it('optimistic overlay survives page ingest: confirmed base updates, pendings replay on top', async () => {
    childrenPages.push({
      items: [{ $path: '/q/c', $type: 'test.ro.counter', $rev: 1, count: 0 }],
      total: 1,
    });
    const source = createClientTreeSource();
    const h = source.mountChildren('/q', { limit: 10 });
    await waitChildren('/q', ready('/q'));

    pushOptimistic('/q/c', Counter, undefined, incrementAction, undefined, 'op1');
    assert.equal(countOf('/q/c'), 1);

    // Refetch returns a fresher confirmed base (foreign writes landed).
    childrenPages.push({
      items: [{ $path: '/q/c', $type: 'test.ro.counter', $rev: 2, count: 5 }],
      total: 1,
    });
    h.refetch();
    await waitChildren('/q', () => getChildrenCalls.length === 2 && cache.getChildrenPhase('/q') === 'ready');

    assert.equal(countOf('/q/c'), 6, 'confirmed 5 + replayed pending increment');
    assert.equal(hasPending('/q/c', 'op1'), true, 'overlay not clobbered by the page');

    // The op's by-event settles it on the new base.
    applyDataEvent({ type: 'patch', path: '/q/c', patches: [['r', 'count', 6]], rev: 3, by: 'op1' });
    assert.equal(countOf('/q/c'), 6);
    assert.equal(cache.get('/q/c')?.$rev, 3);
    assert.equal(hasPending('/q/c'), false);
    h.dispose();
  });
});

describe('vp dirty reaches mounted listings (ns6p.4 F1, invariants 16/19)', () => {
  it('idle vp dirty with no mounted resource: no fetch, no crash', async () => {
    applyDataEvent({ type: 'set', path: '/items/y', node: { $type: 'doc', $rev: 1 }, invalidateVps: ['/nobody'] });
    await flush();
    assert.equal(getChildrenCalls.length, 0);
  });

  it('vp dirty on a SETTLED listing refetches through the mount itself — no loadChildren wiring', async () => {
    childrenPages.push({ items: [node('/vp/a')], total: 1 });
    const source = createClientTreeSource();
    const h = source.mountChildren('/vp', { limit: 10, watchNew: true });
    await waitChildren('/vp', ready('/vp'));
    assert.equal(getChildrenCalls.length, 1, 'page settled, nothing in flight');

    // Membership flipped server-side; the event names the vp only. Production
    // startEvents passes NO loadChildren — the mount must heal itself.
    childrenPages.push({ items: [node('/vp/a'), node('/vp/b')], total: 2 });
    applyDataEvent({ type: 'set', path: '/items/x', node: { $type: 'doc', $rev: 1 }, invalidateVps: ['/vp'] });

    await waitChildren('/vp', () =>
      getChildrenCalls.length === 2 && cache.getChildrenPhase('/vp') === 'ready'
      && members('/vp').includes('/vp/b'));
    h.dispose();
  });
});

describe('exact-read overlap ordering (ns6p.4 F2, invariants 17/18)', () => {
  it('create event during an in-flight get: the older absent response cannot delete the created node', async () => {
    const dg = deferred<NodeData | null>();
    getResults.push(dg.promise, node('/cx', 1, 'born'));
    const source = createClientTreeSource();
    const h = source.mountPath('/cx');
    const before = getQuery.mock.callCount();

    applyDataEvent({ type: 'set', path: '/cx', node: { $type: 'doc', $rev: 1, v: 'born' } });
    assert.equal(vOf('/cx'), 'born', 'event created the node');

    dg.resolve(null); // server snapshot predates the create
    await flush();

    assert.ok(cache.get('/cx'), 'older absent response must not delete the created node');
    assert.notEqual(cache.getPathStatus('/cx'), 'not_found');

    // The coalesced re-get settles the truth.
    await waitPath('/cx', () =>
      getQuery.mock.callCount() === before + 1 && cache.getPathStatus('/cx') === 'ready');
    assert.equal(vOf('/cx'), 'born');
    h.dispose();
  });

  it('remove during an in-flight get: the older node response cannot permanently resurrect it', async () => {
    const dg = deferred<NodeData | null>();
    getResults.push(dg.promise, null);
    const source = createClientTreeSource();
    const h = source.mountPath('/rx');

    applyDataEvent({ type: 'remove', path: '/rx' });

    dg.resolve(node('/rx', 1, 'zombie')); // snapshot predates the remove
    await waitPath('/rx', () => cache.getPathStatus('/rx') === 'not_found');

    assert.equal(cache.get('/rx'), undefined, 'reconverge re-get healed the resurrection');
    h.dispose();
  });
});

describe('multi-query gate (ns6p.4 F5, §4.2)', () => {
  it('second different-query mount is non-live and loud; a remount after the first unmounts goes live', async () => {
    const errors = mock.method(console, 'error', () => {});
    childrenPages.push(
      { items: [node('/mq/a')], total: 1 },
      { items: [node('/mq/b')], total: 1 },
      { items: [node('/mq/b')], total: 1 },
    );
    const source = createClientTreeSource();

    const h1 = source.mountChildren('/mq', { query: { kind: 'a' }, watchNew: true, limit: 10 });
    await waitChildren('/mq', () => getChildrenCalls.length === 1 && ready('/mq')());
    assert.equal(getChildrenCalls[0].watchNew, true, 'first mount registers live');
    assert.equal(getChildrenCalls[0].token, 'test-tab');

    const h2 = source.mountChildren('/mq', { query: { kind: 'b' }, watchNew: true, limit: 10 });
    await waitChildren('/mq', () => getChildrenCalls.length === 2 && ready('/mq')());
    assert.equal(getChildrenCalls[1].watchNew, undefined, 'gated mount must not open a second live query stream');
    assert.equal(getChildrenCalls[1].token, undefined, 'no registration input at all');
    assert.ok(errors.mock.calls.length >= 1, 'the gate is loud (core-jsh1)');

    h1.dispose();
    const h3 = source.mountChildren('/mq', { query: { kind: 'b' }, watchNew: true, limit: 10 });
    await waitChildren('/mq', () => getChildrenCalls.length === 3 && ready('/mq')());
    assert.equal(getChildrenCalls[2].watchNew, true, 'gate lifted — the remount goes live');
    assert.equal(getChildrenCalls[2].token, 'test-tab');

    h2.dispose();
    h3.dispose();
  });
});
