// E2E rebase tests — simulates full flow: execute → optimistic → deferred server → verify
// Reproduces: "first server return resets state" bug

import { registerType } from '@treenx/core/comp';
import { resolve } from '@treenx/core';
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import * as cache from './cache';
import {
  applyServerPatch,
  applyServerSet,
  clear,
  confirmFromResponse,
  hasPending,
  pushOptimistic,
  rollback,
} from './rebase';

// ── Test type: checklist with server-enriched fields ──

class Checklist {
  items: { id: number; text: string; done: boolean }[] = [];

  add(data: { text: string }) {
    const id = this.items.reduce((max, i) => Math.max(max, i.id), 0) + 1;
    this.items.push({ id, text: data.text, done: false });
  }

  toggle(data: { id: number }) {
    const item = this.items.find(i => i.id === data.id);
    if (!item) throw new Error('not found');
    item.done = !item.done;
  }

  remove(data: { id: number }) {
    const idx = this.items.findIndex(i => i.id === data.id);
    if (idx >= 0) this.items.splice(idx, 1);
  }
}
registerType('test.e2e.checklist', Checklist);

class Counter {
  count = 0;
  increment() { this.count++; }
}
registerType('test.e2e.counter', Counter);

const action = (type: string, name: string) => resolve(type, `action:${name}`, false)!;

let opSeq = 0;
afterEach(() => { cache.clear(); clear(); opSeq = 0; });

// ── Helper: simulate what hooks.ts execute() does ──
// Mints an opId per call (as execute() does) and returns it so the test can
// echo it back as the server event's `by` — the ack correlation of core-gk8.1.

function simulateExecute(
  path: string, actionName: string, data: unknown,
  key?: string,
): string {
  const cached = cache.get(path);
  if (!cached) throw new Error(`no cache for ${path}`);

  const compType = key
    ? (cached[`#${key}`] as { $type?: string })?.$type ?? cached.$type
    : cached.$type;

  const cls = resolve(compType, 'class');
  const actionFn = resolve(compType, `action:${actionName}`, false);
  const opId = `op${++opSeq}`;
  if (cls && actionFn) pushOptimistic(path, cls, key, actionFn, data, opId);
  return opId;
}

// ── Tests ──

describe('rebase e2e — deferred server responses', () => {

  it('3 rapid adds, server patches arrive one by one — no state reset', () => {
    // Initial: empty checklist as named component
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': { $type: 'test.e2e.checklist', items: [] },
    } as any);

    const items = () => (cache.get('/todo') as any)['#checklist'].items;

    // Client: 3 rapid adds (server hasn't responded yet)
    const id1 = simulateExecute('/todo', 'add', { text: 'Buy milk' }, 'checklist');
    assert.strictEqual(items().length, 1, 'optimistic: 1 item');
    assert.strictEqual(items()[0].text, 'Buy milk');

    const id2 = simulateExecute('/todo', 'add', { text: 'Walk dog' }, 'checklist');
    assert.strictEqual(items().length, 2, 'optimistic: 2 items');

    const id3 = simulateExecute('/todo', 'add', { text: 'Code review' }, 'checklist');
    assert.strictEqual(items().length, 3, 'optimistic: 3 items');

    // ── Server responds for ADD #1 ──
    // Server may enrich with timestamps, UUIDs etc.
    applyServerPatch('/todo', [
      ['a', '#checklist.items.0', { id: 1, text: 'Buy milk', done: false }],
    ], undefined, id1);

    // BUG SCENARIO: if rebase is broken, items will show only 1 (server state)
    // Correct: confirmed has 1 item, + replay add #2 + add #3 = 3 items
    assert.strictEqual(items().length, 3, 'after server #1: still 3 items (2 pending replayed)');
    assert.strictEqual(items()[0].text, 'Buy milk', 'confirmed item');
    assert.strictEqual(items()[1].text, 'Walk dog', 'replayed optimistic');
    assert.strictEqual(items()[2].text, 'Code review', 'replayed optimistic');
    assert.strictEqual(hasPending('/todo'), true, '2 ops still pending');

    // ── Server responds for ADD #2 ──
    applyServerPatch('/todo', [
      ['a', '#checklist.items.1', { id: 2, text: 'Walk dog', done: false }],
    ], undefined, id2);
    assert.strictEqual(items().length, 3, 'after server #2: still 3 items (1 pending)');
    assert.strictEqual(hasPending('/todo'), true, '1 op still pending');

    // ── Server responds for ADD #3 ──
    applyServerPatch('/todo', [
      ['a', '#checklist.items.2', { id: 3, text: 'Code review', done: false }],
    ], undefined, id3);
    assert.strictEqual(items().length, 3, 'after server #3: 3 items confirmed');
    assert.strictEqual(hasPending('/todo'), false, 'all confirmed, cleaned up');
  });

  it('server enriches data that client didnt have — enrichment survives replay', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': { $type: 'test.e2e.checklist', items: [] },
    } as any);

    const items = () => (cache.get('/todo') as any)['#checklist'].items;

    // 2 rapid adds
    const id1 = simulateExecute('/todo', 'add', { text: 'A' }, 'checklist');
    const id2 = simulateExecute('/todo', 'add', { text: 'B' }, 'checklist');
    assert.strictEqual(items().length, 2);

    // Server for #1: adds createdAt, server-generated UUID
    applyServerPatch('/todo', [
      ['a', '#checklist.items.0', { id: 1, text: 'A', done: false, createdAt: '2026-04-03T10:00:00Z' }],
    ], undefined, id1);

    assert.strictEqual(items().length, 2, 'still 2 after server #1');
    assert.strictEqual(items()[0].createdAt, '2026-04-03T10:00:00Z', 'server enrichment on confirmed');
    // Item B is replayed from confirmed — no createdAt yet (client doesn't know it)
    assert.strictEqual(items()[1].text, 'B', 'replayed');

    // Server for #2: also enriched
    applyServerPatch('/todo', [
      ['a', '#checklist.items.1', { id: 2, text: 'B', done: false, createdAt: '2026-04-03T10:00:01Z' }],
    ], undefined, id2);
    assert.strictEqual(items()[1].createdAt, '2026-04-03T10:00:01Z', 'server enrichment preserved');
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('rapid toggle + add interleaved — server order matches client order', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'Existing', done: false }],
      },
    } as any);

    const items = () => (cache.get('/todo') as any)['#checklist'].items;

    // Toggle existing item
    const idToggle = simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(items()[0].done, true, 'optimistic toggle');

    // Add new item while toggle is in-flight
    const idAdd = simulateExecute('/todo', 'add', { text: 'New' }, 'checklist');
    assert.strictEqual(items().length, 2, 'optimistic add');
    assert.strictEqual(items()[0].done, true, 'toggle still visible');

    // Server confirms toggle
    applyServerPatch('/todo', [
      ['r', '#checklist.items.0.done', true ],
    ], undefined, idToggle);
    assert.strictEqual(items().length, 2, 'add still replayed after toggle confirmed');
    assert.strictEqual(items()[0].done, true, 'toggle confirmed');
    assert.strictEqual(items()[1].text, 'New', 'add replayed');
    assert.strictEqual(hasPending('/todo'), true);

    // Server confirms add
    applyServerPatch('/todo', [
      ['a', '#checklist.items.1', { id: 2, text: 'New', done: false }],
    ], undefined, idAdd);
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('server set (full node) after optimistic — remaining ops survive', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': { $type: 'test.e2e.checklist', items: [] },
    } as any);

    const items = () => (cache.get('/todo') as any)['#checklist'].items;

    // 3 rapid adds
    const id1 = simulateExecute('/todo', 'add', { text: 'A' }, 'checklist');
    simulateExecute('/todo', 'add', { text: 'B' }, 'checklist');
    simulateExecute('/todo', 'add', { text: 'C' }, 'checklist');
    assert.strictEqual(items().length, 3);

    // Server sends FULL NODE (set event, not patch) for first add
    applyServerSet('/todo', {
      $path: '/todo', $type: 'dir',
      '#checklist': {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'A', done: false }],
        lastModified: '2026-04-03',
      },
    } as any, id1);

    assert.strictEqual(items().length, 3, 'set + replay = 3 items');
    assert.strictEqual(items()[0].text, 'A');
    assert.strictEqual(items()[1].text, 'B', 'replayed');
    assert.strictEqual(items()[2].text, 'C', 'replayed');
    assert.strictEqual(
      (cache.get('/todo') as any)['#checklist'].lastModified,
      '2026-04-03',
      'server-added field preserved through replay',
    );
  });

  it('rollback middle of 3 — first and third survive (cnr.6 fixed)', () => {
    cache.put({
      $path: '/c', $type: 'test.e2e.counter', count: 0,
    } as any);

    const count = () => (cache.get('/c') as any).count;

    // 3 rapid increments
    const id1 = simulateExecute('/c', 'increment', undefined);
    const id2 = simulateExecute('/c', 'increment', undefined);
    const id3 = simulateExecute('/c', 'increment', undefined);
    assert.strictEqual(count(), 3, '3 optimistic');

    // Server confirms first
    applyServerPatch('/c', [['r', 'count', 1 ]], undefined, id1);
    assert.strictEqual(count(), 3, 'confirmed 1 + 2 replayed = 3');

    // The MIDDLE op fails on the server → rollback targets it by id.
    // Pre-fix, blind pop() dropped id3 (the last) instead — the cnr.6 bug.
    rollback('/c', id2);
    assert.strictEqual(count(), 2, 'confirmed 1 + replay id3 only = 2');
    assert.strictEqual(hasPending('/c'), true, 'id3 still pending');

    // Server confirms the surviving third op
    applyServerPatch('/c', [['r', 'count', 2 ]], undefined, id3);
    assert.strictEqual(count(), 2, 'all confirmed');
    assert.strictEqual(hasPending('/c'), false);
  });

  it('node-level component (no key) — rapid ops preserve state', () => {
    cache.put({
      $path: '/c', $type: 'test.e2e.counter', count: 10,
    } as any);

    const count = () => (cache.get('/c') as any).count;

    // 5 rapid increments, no key
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(simulateExecute('/c', 'increment', undefined));
    assert.strictEqual(count(), 15, '5 optimistic');

    // Server confirms one by one
    for (let i = 0; i < 5; i++) {
      applyServerPatch('/c', [['r', 'count', 11 + i ]], undefined, ids[i]);
      assert.strictEqual(count(), 15, `after server #${i + 1}: count stays 15`);
    }

    assert.strictEqual(hasPending('/c'), false, 'all confirmed');
    assert.strictEqual(count(), 15, 'final state correct');
  });

  it('concurrent ops on DIFFERENT paths — independent rebase', () => {
    cache.put({ $path: '/a', $type: 'test.e2e.counter', count: 0 } as any);
    cache.put({ $path: '/b', $type: 'test.e2e.counter', count: 100 } as any);

    const a1 = simulateExecute('/a', 'increment', undefined);
    const b1 = simulateExecute('/b', 'increment', undefined);
    const a2 = simulateExecute('/a', 'increment', undefined);

    assert.strictEqual((cache.get('/a') as any).count, 2);
    assert.strictEqual((cache.get('/b') as any).count, 101);

    // Server confirms /b first (out of call order — different paths are independent)
    applyServerPatch('/b', [['r', 'count', 101 ]], undefined, b1);
    assert.strictEqual((cache.get('/b') as any).count, 101);
    assert.strictEqual(hasPending('/b'), false);

    // /a still pending
    assert.strictEqual(hasPending('/a'), true);
    assert.strictEqual((cache.get('/a') as any).count, 2);

    // Server confirms /a #1
    applyServerPatch('/a', [['r', 'count', 1 ]], undefined, a1);
    assert.strictEqual((cache.get('/a') as any).count, 2, 'replay second inc');

    // Server confirms /a #2
    applyServerPatch('/a', [['r', 'count', 2 ]], undefined, a2);
    assert.strictEqual((cache.get('/a') as any).count, 2);
    assert.strictEqual(hasPending('/a'), false);
  });

  it('no optimistic → server patch applied directly (no rebase state)', () => {
    cache.put({ $path: '/c', $type: 'test.e2e.counter', count: 5 } as any);

    // Server sends a patch without any prior optimistic call
    const handled = applyServerPatch('/c', [['r', 'count', 10 ]]);
    assert.strictEqual(handled, false, 'no rebase state → not handled');

    // Cache should NOT have been modified by applyServerPatch when it returns false
    assert.strictEqual((cache.get('/c') as any).count, 5, 'cache unchanged');
  });

  it('remove after add — replay produces correct final state', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'Keep', done: false }],
      },
    } as any);

    const items = () => (cache.get('/todo') as any)['#checklist'].items;

    // Add then immediately remove the new item
    const idAdd = simulateExecute('/todo', 'add', { text: 'Temp' }, 'checklist');
    assert.strictEqual(items().length, 2);
    assert.strictEqual(items()[1].text, 'Temp');
    assert.strictEqual(items()[1].id, 2, 'optimistic id=2');

    const idRemove = simulateExecute('/todo', 'remove', { id: 2 }, 'checklist');
    assert.strictEqual(items().length, 1, 'optimistic: added then removed');

    // Server confirms add
    applyServerPatch('/todo', [
      ['a', '#checklist.items.1', { id: 2, text: 'Temp', done: false }],
    ], undefined, idAdd);
    // Confirmed has 2 items, replay remove(id:2) → 1 item
    assert.strictEqual(items().length, 1, 'confirmed + replay remove = 1');
    assert.strictEqual(items()[0].text, 'Keep');

    // Server confirms remove
    applyServerPatch('/todo', [
      ['d', '#checklist.items.1'],
    ], undefined, idRemove);
    assert.strictEqual(items().length, 1);
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('rapid toggle off then toggle on — server delay doesnt reset state', () => {
    // Exact scenario: item is checked, user unchecks, then quickly re-checks.
    // Server has 1s delay on toggle. First server response must not kill the second toggle.
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'Task', done: true }],
      },
    } as any);

    const done = () => (cache.get('/todo') as any)['#checklist'].items[0].done;

    // Toggle OFF (true → false)
    const id1 = simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), false, 'optimistic: unchecked');

    // Toggle ON immediately (false → true)
    const id2 = simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), true, 'optimistic: re-checked (double toggle = original)');

    // Server responds for toggle #1 (delayed): done changed to false
    applyServerPatch('/todo', [
      ['r', '#checklist.items.0.done', false ],
    ], undefined, id1);

    // BUG SCENARIO: without rebase, server "false" overwrites optimistic "true"
    // Correct: confirmed=false, replay toggle #2 → true
    assert.strictEqual(done(), true, 'after server #1: replay toggle ON keeps it checked');
    assert.strictEqual(hasPending('/todo'), true, 'toggle #2 still pending');

    // Server responds for toggle #2: done changed to true
    applyServerPatch('/todo', [
      ['r', '#checklist.items.0.done', true ],
    ], undefined, id2);
    assert.strictEqual(done(), true, 'confirmed: checked');
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('triple toggle race — each server response replays remaining', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'X', done: false }],
      },
    } as any);

    const done = () => (cache.get('/todo') as any)['#checklist'].items[0].done;

    // 3 rapid toggles: false→true→false→true
    const id1 = simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), true, 'toggle 1');
    const id2 = simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), false, 'toggle 2');
    const id3 = simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), true, 'toggle 3');

    // Server #1: done=true
    applyServerPatch('/todo', [['r', '#checklist.items.0.done', true ]], undefined, id1);
    // confirmed=true, replay toggle→false, toggle→true = true
    assert.strictEqual(done(), true, 'after server #1');

    // Server #2: done=false
    applyServerPatch('/todo', [['r', '#checklist.items.0.done', false ]], undefined, id2);
    // confirmed=false, replay toggle→true
    assert.strictEqual(done(), true, 'after server #2');

    // Server #3: done=true
    applyServerPatch('/todo', [['r', '#checklist.items.0.done', true ]], undefined, id3);
    assert.strictEqual(done(), true, 'after server #3');
    assert.strictEqual(hasPending('/todo'), false);
  });

  // ── Ack-via-response (core-anz4.13) — R+W-without-S callers get no event ──
  // simulateExecute = the optimistic half of hooks.execute; confirmFromResponse
  // = what execute() calls on success with the authoritative refetch.

  it('no event delivery: response refetch confirms the op; the late by-event is suppressed, not double-applied', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      '#checklist': { $type: 'test.e2e.checklist', items: [] },
    } as any);
    const items = () => (cache.get('/todo') as any)['#checklist'].items;

    const id1 = simulateExecute('/todo', 'add', { text: 'A' }, 'checklist');
    const id2 = simulateExecute('/todo', 'add', { text: 'B' }, 'checklist');
    assert.strictEqual(items().length, 2, 'optimistic');
    assert.strictEqual(hasPending('/todo', id1), true, 'per-op probe sees op1');

    // execute #1 resolved; NO event arrives (no S). Refetch shows op1 committed.
    confirmFromResponse('/todo', id1, {
      $path: '/todo', $type: 'dir', $rev: 2,
      '#checklist': { $type: 'test.e2e.checklist', items: [{ id: 1, text: 'A', done: false }] },
    } as any);

    assert.strictEqual(hasPending('/todo', id1), false, 'op1 confirmed from response');
    assert.strictEqual(hasPending('/todo', id2), true, 'op2 still pending');
    assert.strictEqual(items().length, 2, 'confirmed A + replayed B');
    assert.strictEqual(items()[0].id, 1, 'authoritative server enrichment');

    // The by-matched event arrives after all (S present / another consumer):
    // must be handled WITHOUT re-applying — a second append would show 3 items.
    const handled = applyServerPatch('/todo', [
      ['a', '#checklist.items.0', { id: 1, text: 'A', done: false }],
    ], 2, id1);
    assert.strictEqual(handled, true, 'suppressed event counts as handled — no cache fallback');
    assert.strictEqual(items().length, 2, 'not double-applied');

    // op2 settles through the normal event lane — suppression is per-op.
    applyServerPatch('/todo', [
      ['a', '#checklist.items.1', { id: 2, text: 'B', done: false }],
    ], 3, id2);
    assert.strictEqual(items().length, 2);
    assert.strictEqual(hasPending('/todo'), false, 'all confirmed');
  });

  it('suppression consumed once: a later foreign patch with no by applies normally', () => {
    cache.put({ $path: '/c', $type: 'test.e2e.counter', count: 0 } as any);
    const id = simulateExecute('/c', 'increment', undefined);
    confirmFromResponse('/c', id, { $path: '/c', $type: 'test.e2e.counter', count: 1, $rev: 2 } as any);
    assert.strictEqual(hasPending('/c'), false);
    assert.strictEqual((cache.get('/c') as any).count, 1);

    applyServerPatch('/c', [['r', 'count', 1]], 2, id); // late own event — suppressed
    assert.strictEqual((cache.get('/c') as any).count, 1);

    // No rebase state, suppression spent → foreign event falls through to the
    // caller's cache path (events.ts fallback), exactly as before the fix.
    const handled = applyServerPatch('/c', [['r', 'count', 5]], 3, 'someone-else');
    assert.strictEqual(handled, false, 'foreign by is never suppressed');
  });

  it('event ack raced ahead of the response: confirm heals confirmed onto the fresher refetch', () => {
    cache.put({ $path: '/c', $type: 'test.e2e.counter', count: 0 } as any);
    const id1 = simulateExecute('/c', 'increment', undefined);
    const id2 = simulateExecute('/c', 'increment', undefined);

    // Event for op1 lands BEFORE the response refetch completes.
    applyServerPatch('/c', [['r', 'count', 1]], 2, id1);
    assert.strictEqual(hasPending('/c', id1), false);

    // Refetch (started after commit of op1) resolves now — op1 gone from
    // pending; the refetched node still replaces confirmed, op2 replays on top.
    confirmFromResponse('/c', id1, { $path: '/c', $type: 'test.e2e.counter', count: 1, $rev: 2 } as any);
    assert.strictEqual((cache.get('/c') as any).count, 2, 'confirmed 1 + replay op2');
    assert.strictEqual(hasPending('/c', id2), true);

    applyServerPatch('/c', [['r', 'count', 2]], 3, id2);
    assert.strictEqual((cache.get('/c') as any).count, 2);
    assert.strictEqual(hasPending('/c'), false);
  });

  it('refetch denied (FORBIDDEN/gone): success stands, pending + cache entry cleared', () => {
    cache.put({ $path: '/c', $type: 'test.e2e.counter', count: 0 } as any);
    const id = simulateExecute('/c', 'increment', undefined);
    assert.strictEqual(hasPending('/c', id), true);

    // hooks.confirmPending maps a FORBIDDEN refetch (or null node) to undefined.
    confirmFromResponse('/c', id, undefined);

    assert.strictEqual(hasPending('/c'), false, 'overlay dropped');
    assert.strictEqual(cache.get('/c'), undefined, 'unreadable node evicted from cache');
  });

  it('suppressed set event: refetched state wins over the older event image', () => {
    cache.put({ $path: '/c', $type: 'test.e2e.counter', count: 0 } as any);
    const id = simulateExecute('/c', 'increment', undefined);
    confirmFromResponse('/c', id, { $path: '/c', $type: 'test.e2e.counter', count: 1, $rev: 5 } as any);

    const handled = applyServerSet('/c', { $path: '/c', $type: 'test.e2e.counter', count: 1, $rev: 4 } as any, id);
    assert.strictEqual(handled, true, 'set event suppressed');
    assert.strictEqual((cache.get('/c') as any).$rev, 5, 'refetched rev kept');
  });

  it('frozen cache objects dont break rebase', () => {
    // cache.put freezes in dev mode — verify structuredClone unfreezes properly
    const node = { $path: '/c', $type: 'test.e2e.counter', count: 0 } as any;
    cache.put(node);

    // In dev mode, cache.get returns frozen object
    const cached = cache.get('/c');
    if (cached && Object.isFrozen(cached)) {
      // structuredClone in pushOptimistic should produce unfrozen copy
      const id = simulateExecute('/c', 'increment', undefined);
      assert.strictEqual((cache.get('/c') as any).count, 1, 'works with frozen cache');

      applyServerPatch('/c', [['r', 'count', 1 ]], undefined, id);
      assert.strictEqual(hasPending('/c'), false);
    } else {
      // Not frozen (prod mode) — just verify basic flow
      const id = simulateExecute('/c', 'increment', undefined);
      assert.strictEqual((cache.get('/c') as any).count, 1);
      applyServerPatch('/c', [['r', 'count', 1 ]], undefined, id);
      assert.strictEqual(hasPending('/c'), false);
    }
  });
});
