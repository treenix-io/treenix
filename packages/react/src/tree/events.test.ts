// Exact-path invalidation handling (ns6p.4 §3.4 slice 1): an invalidate with
// `paths` names a held node whose payload was ACL-dropped server-side. The
// client must refetch it through the normal read path; a denied/gone refetch
// EVICTS the entry — keeping it would freeze data the reader may no longer see.

import { registerType } from '@treenx/core/comp';
import { resolve, type NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as cache from './cache';
import { applyDataEvent, refetchInvalidatedPath, stopEvents } from './events';
import { clear as clearRebase, hasPending, ingestNode, pushOptimistic, rollback } from './rebase';

const node = (path: string, v: number): NodeData => ({ $path: path, $type: 't', v });

/** Resolves on the next cache notification for `path` (put or remove). */
function nextCacheChange(path: string): Promise<void> {
  return new Promise((resolve) => {
    const unsub = cache.subscribePath(path, () => {
      unsub();
      resolve();
    });
  });
}

describe('events — refetchInvalidatedPath', () => {
  beforeEach(() => cache.clear());
  afterEach(() => {
    stopEvents(); // clears coalesce timers so no fetch fires into the next test
    mock.restoreAll();
  });

  it('refetches the invalidated node and replaces the cache entry', async () => {
    cache.put(node('/a', 1));
    const changed = nextCacheChange('/a');

    refetchInvalidatedPath('/a', async (path) => node(path, 2));
    await changed;

    assert.equal((cache.get('/a') as { v?: number } | undefined)?.v, 2);
  });

  it('FORBIDDEN refetch: entry evicted, error logged, nothing thrown', async () => {
    const errors = mock.method(console, 'error', () => {});
    cache.put(node('/denied', 1));
    const changed = nextCacheChange('/denied');

    refetchInvalidatedPath('/denied', async () => {
      throw Object.assign(new Error('forbidden'), { data: { code: 'FORBIDDEN' } });
    });
    await changed;

    assert.equal(cache.get('/denied'), undefined, 'stale entry must not survive a denied refetch');
    assert.ok(errors.mock.calls.length >= 1, 'the eviction is loud');
  });

  it('node gone on refetch (null): entry evicted', async () => {
    cache.put(node('/gone', 1));
    const changed = nextCacheChange('/gone');

    refetchInvalidatedPath('/gone', async () => null);
    await changed;

    assert.equal(cache.get('/gone'), undefined);
  });

  it('coalesces a burst of invalidations into one refetch', async () => {
    cache.put(node('/hot', 1));
    const changed = nextCacheChange('/hot');
    let fetches = 0;

    const fetchNode = async (path: string) => {
      fetches++;
      return node(path, 9);
    };
    refetchInvalidatedPath('/hot', fetchNode);
    refetchInvalidatedPath('/hot', fetchNode);
    refetchInvalidatedPath('/hot', fetchNode);
    await changed;

    assert.equal(fetches, 1, 'burst collapses into one fetch');
    assert.equal((cache.get('/hot') as { v?: number } | undefined)?.v, 9);
  });
});

// ── Data-event rev machine (ns6p.4 §3.3, §3.3.3a) ──
// Before the machine, events applied with zero rev comparison: a late
// duplicate double-applied non-idempotent ops, an event older than the cache
// regressed it. These tests pin the ≤skip / +1-apply / gap-refetch contract.

class Counter {
  count = 0;
  increment() { this.count++; }
}
registerType('test.events.counter', Counter);
const incrementAction = resolve('test.events.counter', 'action:increment', false)!;

const cnode = (rev: number, count: number): NodeData =>
  ({ $path: '/n', $type: 'test.events.counter', $rev: rev, count });
const vnode = (path: string, rev: number | undefined, v: string): NodeData =>
  rev === undefined ? { $path: path, $type: 'doc', v } : { $path: path, $type: 'doc', $rev: rev, v };
const countOf = (p: string) => (cache.get(p) as { count?: number } | undefined)?.count;
const vOf = (p: string) => (cache.get(p) as { v?: string } | undefined)?.v;

describe('events — data-event rev machine', () => {
  beforeEach(() => { cache.clear(); clearRebase(); });
  afterEach(() => { stopEvents(); mock.restoreAll(); });

  it('late duplicate patch (rev <= cached): skipped, cache unchanged, by-ack consumed so the pending op settles', () => {
    cache.put(cnode(1, 4));
    pushOptimistic('/n', Counter, undefined, incrementAction, undefined, 'op1');
    assert.equal(countOf('/n'), 5, 'optimistic');

    // Snapshot read raced ahead of the ack: rev 2 already includes op1's write.
    cache.put(ingestNode(cnode(2, 5)));
    assert.equal(countOf('/n'), 6, 'confirmed 5 + replayed pending');

    applyDataEvent({ type: 'patch', path: '/n', patches: [['r', 'count', 5]], rev: 2, by: 'op1' });

    assert.equal(countOf('/n'), 5, 'duplicate not re-applied; consumed op no longer replayed');
    assert.equal(cache.get('/n')?.$rev, 2);
    assert.equal(hasPending('/n'), false, 'ack consumed despite the skip');
  });

  it('patch rev == cached+1 applies; second delivery of the same rev is a no-op', () => {
    cache.put(vnode('/p', 2, 'old'));

    applyDataEvent({ type: 'patch', path: '/p', patches: [['r', 'v', 'new']], rev: 3 });
    assert.equal(vOf('/p'), 'new');
    assert.equal(cache.get('/p')?.$rev, 3);

    applyDataEvent({ type: 'patch', path: '/p', patches: [['r', 'v', 'twice?']], rev: 3 });
    assert.equal(vOf('/p'), 'new', 'redelivery skipped');
  });

  it('patch rev gap: cache untouched until the coalesced refetch lands', async () => {
    cache.put(vnode('/g', 2, 'old'));
    let fetches = 0;
    const changed = nextCacheChange('/g');

    applyDataEvent(
      { type: 'patch', path: '/g', patches: [['r', 'v', 'lost-context']], rev: 7 },
      undefined,
      async (path) => { fetches++; return vnode(path, 7, 'refetched'); },
    );

    assert.equal(vOf('/g'), 'old', 'gap ops must not compose onto an older image');
    await changed;
    assert.equal(fetches, 1);
    assert.equal(vOf('/g'), 'refetched');
    assert.equal(cache.get('/g')?.$rev, 7);
  });

  it('missing / non-numeric event rev, or unversioned cached node: refetch branch, nothing throws', async () => {
    cache.put(vnode('/m1', 2, 'cur'));
    const c1 = nextCacheChange('/m1');
    applyDataEvent(
      { type: 'patch', path: '/m1', patches: [['r', 'v', 'x']] },
      undefined, async (path) => vnode(path, 3, 'fetched1'),
    );
    await c1;
    assert.equal(vOf('/m1'), 'fetched1');

    cache.put(vnode('/m2', 2, 'cur'));
    const c2 = nextCacheChange('/m2');
    applyDataEvent(
      { type: 'patch', path: '/m2', patches: [['r', 'v', 'x']], rev: 'not-a-number' },
      undefined, async (path) => vnode(path, 3, 'fetched2'),
    );
    await c2;
    assert.equal(vOf('/m2'), 'fetched2');

    // mimefs-class: cached node has no usable rev at all.
    cache.put(vnode('/m3', undefined, 'cur'));
    const c3 = nextCacheChange('/m3');
    applyDataEvent(
      { type: 'patch', path: '/m3', patches: [['r', 'v', 'x']], rev: 3 },
      undefined, async (path) => vnode(path, undefined, 'fetched3'),
    );
    await c3;
    assert.equal(vOf('/m3'), 'fetched3');
  });

  it('set ahead of cache applies without +1 contiguity; stale same-$id set is skipped', () => {
    cache.put({ $path: '/s', $type: 'doc', $id: 'g1', $rev: 5, v: 'cur' });

    applyDataEvent({ type: 'set', path: '/s', node: { $type: 'doc', $id: 'g1', $rev: 9, v: 'jump' } });
    assert.equal(vOf('/s'), 'jump', 'full image with newer rev is authoritative');

    applyDataEvent({ type: 'set', path: '/s', node: { $type: 'doc', $id: 'g1', $rev: 4, v: 'old' } });
    assert.equal(vOf('/s'), 'jump', 'stale duplicate skipped');
    assert.equal(cache.get('/s')?.$rev, 9);
  });

  it('set with a different $id at a LOWER rev applies — generation change, never skipped-as-stale (invariant 29)', () => {
    cache.put({ $path: '/r', $type: 'doc', $id: 'g1', $rev: 5, v: 'first-life' });

    applyDataEvent({ type: 'set', path: '/r', node: { $type: 'doc', $id: 'g2', $rev: 1, v: 'reborn' } });

    assert.equal(vOf('/r'), 'reborn');
    assert.equal(cache.get('/r')?.$id, 'g2');
    assert.equal(cache.get('/r')?.$rev, 1);
  });

  it('set at equal/lower rev without provable identity: refetch decides, never blind skip', async () => {
    cache.put(vnode('/u', 5, 'cur'));
    const changed = nextCacheChange('/u');
    let fetches = 0;

    applyDataEvent(
      { type: 'set', path: '/u', node: { $type: 'doc', $rev: 5, v: 'other-writer' } },
      undefined, async (path) => { fetches++; return vnode(path, 6, 'authoritative'); },
    );

    assert.equal(vOf('/u'), 'cur', 'no blind apply either');
    await changed;
    assert.equal(fetches, 1);
    assert.equal(vOf('/u'), 'authoritative');
  });

  it('remove is never rev-gated', () => {
    cache.put(vnode('/d', 9, 'x'));
    applyDataEvent({ type: 'remove', path: '/d' });
    assert.equal(cache.get('/d'), undefined);
  });

  it('foreign remove clears the overlay — a later rollback cannot resurrect the node (F4, inv.12/18)', () => {
    cache.put(cnode(1, 4));
    pushOptimistic('/n', Counter, undefined, incrementAction, undefined, 'op1');
    assert.equal(countOf('/n'), 5, 'optimistic');

    applyDataEvent({ type: 'remove', path: '/n' }); // no `by` — another user's remove

    assert.equal(cache.get('/n'), undefined, 'remove is authoritative');
    assert.equal(hasPending('/n'), false, 'overlay state cleared with the node');

    rollback('/n', 'op1'); // the op's server rejection arrives late
    assert.equal(cache.get('/n'), undefined, 'rollback restored nothing — no resurrection');
  });

  it('own remove (`by` ack) consumes the pending op and still leaves nothing to restore (F4)', () => {
    cache.put(cnode(1, 4));
    pushOptimistic('/n', Counter, undefined, incrementAction, undefined, 'op1');

    applyDataEvent({ type: 'remove', path: '/n', by: 'op1' });

    assert.equal(cache.get('/n'), undefined);
    assert.equal(hasPending('/n'), false, 'ack consumed');
    rollback('/n', 'op1');
    assert.equal(cache.get('/n'), undefined);
  });

  it('set on an uncached path enters the cache (nothing to regress)', () => {
    applyDataEvent({ type: 'set', path: '/new', node: { $type: 'doc', $rev: 1, v: 'hello' } });
    assert.equal(vOf('/new'), 'hello');
  });
});
