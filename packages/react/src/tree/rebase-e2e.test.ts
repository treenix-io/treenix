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

afterEach(() => { cache.clear(); clear(); });

// ── Helper: simulate what hooks.ts execute() does ──

function simulateExecute(
  path: string, actionName: string, data: unknown,
  key?: string,
) {
  const cached = cache.get(path);
  if (!cached) throw new Error(`no cache for ${path}`);

  const compType = key
    ? (cached[key] as { $type?: string })?.$type ?? cached.$type
    : cached.$type;

  const cls = resolve(compType, 'class');
  const actionFn = resolve(compType, `action:${actionName}`, false);
  if (cls && actionFn) pushOptimistic(path, cls, key, actionFn, data);
}

// ── Tests ──

describe('rebase e2e — deferred server responses', () => {

  it('3 rapid adds, server patches arrive one by one — no state reset', () => {
    // Initial: empty checklist as named component
    cache.put({
      $path: '/todo', $type: 'dir',
      checklist: { $type: 'test.e2e.checklist', items: [] },
    } as any);

    const items = () => (cache.get('/todo') as any).checklist.items;

    // Client: 3 rapid adds (server hasn't responded yet)
    simulateExecute('/todo', 'add', { text: 'Buy milk' }, 'checklist');
    assert.strictEqual(items().length, 1, 'optimistic: 1 item');
    assert.strictEqual(items()[0].text, 'Buy milk');

    simulateExecute('/todo', 'add', { text: 'Walk dog' }, 'checklist');
    assert.strictEqual(items().length, 2, 'optimistic: 2 items');

    simulateExecute('/todo', 'add', { text: 'Code review' }, 'checklist');
    assert.strictEqual(items().length, 3, 'optimistic: 3 items');

    // ── Server responds for ADD #1 ──
    // Server may enrich with timestamps, UUIDs etc.
    applyServerPatch('/todo', [
      { op: 'add', path: '/checklist/items/0', value: { id: 1, text: 'Buy milk', done: false } },
    ]);

    // BUG SCENARIO: if rebase is broken, items will show only 1 (server state)
    // Correct: confirmed has 1 item, + replay add #2 + add #3 = 3 items
    assert.strictEqual(items().length, 3, 'after server #1: still 3 items (2 pending replayed)');
    assert.strictEqual(items()[0].text, 'Buy milk', 'confirmed item');
    assert.strictEqual(items()[1].text, 'Walk dog', 'replayed optimistic');
    assert.strictEqual(items()[2].text, 'Code review', 'replayed optimistic');
    assert.strictEqual(hasPending('/todo'), true, '2 ops still pending');

    // ── Server responds for ADD #2 ──
    applyServerPatch('/todo', [
      { op: 'add', path: '/checklist/items/1', value: { id: 2, text: 'Walk dog', done: false } },
    ]);
    assert.strictEqual(items().length, 3, 'after server #2: still 3 items (1 pending)');
    assert.strictEqual(hasPending('/todo'), true, '1 op still pending');

    // ── Server responds for ADD #3 ──
    applyServerPatch('/todo', [
      { op: 'add', path: '/checklist/items/2', value: { id: 3, text: 'Code review', done: false } },
    ]);
    assert.strictEqual(items().length, 3, 'after server #3: 3 items confirmed');
    assert.strictEqual(hasPending('/todo'), false, 'all confirmed, cleaned up');
  });

  it('server enriches data that client didnt have — enrichment survives replay', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      checklist: { $type: 'test.e2e.checklist', items: [] },
    } as any);

    const items = () => (cache.get('/todo') as any).checklist.items;

    // 2 rapid adds
    simulateExecute('/todo', 'add', { text: 'A' }, 'checklist');
    simulateExecute('/todo', 'add', { text: 'B' }, 'checklist');
    assert.strictEqual(items().length, 2);

    // Server for #1: adds createdAt, server-generated UUID
    applyServerPatch('/todo', [
      { op: 'add', path: '/checklist/items/0', value: {
        id: 1, text: 'A', done: false, createdAt: '2026-04-03T10:00:00Z',
      }},
    ]);

    assert.strictEqual(items().length, 2, 'still 2 after server #1');
    assert.strictEqual(items()[0].createdAt, '2026-04-03T10:00:00Z', 'server enrichment on confirmed');
    // Item B is replayed from confirmed — no createdAt yet (client doesn't know it)
    assert.strictEqual(items()[1].text, 'B', 'replayed');

    // Server for #2: also enriched
    applyServerPatch('/todo', [
      { op: 'add', path: '/checklist/items/1', value: {
        id: 2, text: 'B', done: false, createdAt: '2026-04-03T10:00:01Z',
      }},
    ]);
    assert.strictEqual(items()[1].createdAt, '2026-04-03T10:00:01Z', 'server enrichment preserved');
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('rapid toggle + add interleaved — server order matches client order', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      checklist: {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'Existing', done: false }],
      },
    } as any);

    const items = () => (cache.get('/todo') as any).checklist.items;

    // Toggle existing item
    simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(items()[0].done, true, 'optimistic toggle');

    // Add new item while toggle is in-flight
    simulateExecute('/todo', 'add', { text: 'New' }, 'checklist');
    assert.strictEqual(items().length, 2, 'optimistic add');
    assert.strictEqual(items()[0].done, true, 'toggle still visible');

    // Server confirms toggle
    applyServerPatch('/todo', [
      { op: 'replace', path: '/checklist/items/0/done', value: true },
    ]);
    assert.strictEqual(items().length, 2, 'add still replayed after toggle confirmed');
    assert.strictEqual(items()[0].done, true, 'toggle confirmed');
    assert.strictEqual(items()[1].text, 'New', 'add replayed');
    assert.strictEqual(hasPending('/todo'), true);

    // Server confirms add
    applyServerPatch('/todo', [
      { op: 'add', path: '/checklist/items/1', value: { id: 2, text: 'New', done: false } },
    ]);
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('server set (full node) after optimistic — remaining ops survive', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      checklist: { $type: 'test.e2e.checklist', items: [] },
    } as any);

    const items = () => (cache.get('/todo') as any).checklist.items;

    // 3 rapid adds
    simulateExecute('/todo', 'add', { text: 'A' }, 'checklist');
    simulateExecute('/todo', 'add', { text: 'B' }, 'checklist');
    simulateExecute('/todo', 'add', { text: 'C' }, 'checklist');
    assert.strictEqual(items().length, 3);

    // Server sends FULL NODE (set event, not patch) for first add
    applyServerSet('/todo', {
      $path: '/todo', $type: 'dir',
      checklist: {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'A', done: false }],
        lastModified: '2026-04-03',
      },
    } as any);

    assert.strictEqual(items().length, 3, 'set + replay = 3 items');
    assert.strictEqual(items()[0].text, 'A');
    assert.strictEqual(items()[1].text, 'B', 'replayed');
    assert.strictEqual(items()[2].text, 'C', 'replayed');
    assert.strictEqual(
      (cache.get('/todo') as any).checklist.lastModified,
      '2026-04-03',
      'server-added field preserved through replay',
    );
  });

  it('rollback middle of 3 — first and third survive', () => {
    cache.put({
      $path: '/c', $type: 'test.e2e.counter', count: 0,
    } as any);

    const count = () => (cache.get('/c') as any).count;

    // 3 rapid increments
    simulateExecute('/c', 'increment', undefined);
    simulateExecute('/c', 'increment', undefined);
    simulateExecute('/c', 'increment', undefined);
    assert.strictEqual(count(), 3, '3 optimistic');

    // Server confirms first
    applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 1 }]);
    assert.strictEqual(count(), 3, 'confirmed 1 + 2 replayed = 3');

    // Second call fails on server → rollback pops LAST pending (not middle!)
    // This is the current behavior — rollback always pops last.
    // If server errors come out of order, this is a known limitation.
    rollback('/c');
    assert.strictEqual(count(), 2, 'rollback popped last, 1 remains');
    assert.strictEqual(hasPending('/c'), true);

    // Server confirms the remaining op
    applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 2 }]);
    assert.strictEqual(count(), 2, 'all confirmed');
    assert.strictEqual(hasPending('/c'), false);
  });

  it('node-level component (no key) — rapid ops preserve state', () => {
    cache.put({
      $path: '/c', $type: 'test.e2e.counter', count: 10,
    } as any);

    const count = () => (cache.get('/c') as any).count;

    // 5 rapid increments, no key
    for (let i = 0; i < 5; i++) simulateExecute('/c', 'increment', undefined);
    assert.strictEqual(count(), 15, '5 optimistic');

    // Server confirms one by one
    for (let i = 0; i < 5; i++) {
      applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 11 + i }]);
      assert.strictEqual(count(), 15, `after server #${i + 1}: count stays 15`);
    }

    assert.strictEqual(hasPending('/c'), false, 'all confirmed');
    assert.strictEqual(count(), 15, 'final state correct');
  });

  it('concurrent ops on DIFFERENT paths — independent rebase', () => {
    cache.put({ $path: '/a', $type: 'test.e2e.counter', count: 0 } as any);
    cache.put({ $path: '/b', $type: 'test.e2e.counter', count: 100 } as any);

    simulateExecute('/a', 'increment', undefined);
    simulateExecute('/b', 'increment', undefined);
    simulateExecute('/a', 'increment', undefined);

    assert.strictEqual((cache.get('/a') as any).count, 2);
    assert.strictEqual((cache.get('/b') as any).count, 101);

    // Server confirms /b first (out of call order — different paths are independent)
    applyServerPatch('/b', [{ op: 'replace', path: '/count', value: 101 }]);
    assert.strictEqual((cache.get('/b') as any).count, 101);
    assert.strictEqual(hasPending('/b'), false);

    // /a still pending
    assert.strictEqual(hasPending('/a'), true);
    assert.strictEqual((cache.get('/a') as any).count, 2);

    // Server confirms /a #1
    applyServerPatch('/a', [{ op: 'replace', path: '/count', value: 1 }]);
    assert.strictEqual((cache.get('/a') as any).count, 2, 'replay second inc');

    // Server confirms /a #2
    applyServerPatch('/a', [{ op: 'replace', path: '/count', value: 2 }]);
    assert.strictEqual((cache.get('/a') as any).count, 2);
    assert.strictEqual(hasPending('/a'), false);
  });

  it('no optimistic → server patch applied directly (no rebase state)', () => {
    cache.put({ $path: '/c', $type: 'test.e2e.counter', count: 5 } as any);

    // Server sends a patch without any prior optimistic call
    const handled = applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 10 }]);
    assert.strictEqual(handled, false, 'no rebase state → not handled');

    // Cache should NOT have been modified by applyServerPatch when it returns false
    assert.strictEqual((cache.get('/c') as any).count, 5, 'cache unchanged');
  });

  it('remove after add — replay produces correct final state', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      checklist: {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'Keep', done: false }],
      },
    } as any);

    const items = () => (cache.get('/todo') as any).checklist.items;

    // Add then immediately remove the new item
    simulateExecute('/todo', 'add', { text: 'Temp' }, 'checklist');
    assert.strictEqual(items().length, 2);
    assert.strictEqual(items()[1].text, 'Temp');
    assert.strictEqual(items()[1].id, 2, 'optimistic id=2');

    simulateExecute('/todo', 'remove', { id: 2 }, 'checklist');
    assert.strictEqual(items().length, 1, 'optimistic: added then removed');

    // Server confirms add
    applyServerPatch('/todo', [
      { op: 'add', path: '/checklist/items/1', value: { id: 2, text: 'Temp', done: false } },
    ]);
    // Confirmed has 2 items, replay remove(id:2) → 1 item
    assert.strictEqual(items().length, 1, 'confirmed + replay remove = 1');
    assert.strictEqual(items()[0].text, 'Keep');

    // Server confirms remove
    applyServerPatch('/todo', [
      { op: 'remove', path: '/checklist/items/1' },
    ]);
    assert.strictEqual(items().length, 1);
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('rapid toggle off then toggle on — server delay doesnt reset state', () => {
    // Exact scenario: item is checked, user unchecks, then quickly re-checks.
    // Server has 1s delay on toggle. First server response must not kill the second toggle.
    cache.put({
      $path: '/todo', $type: 'dir',
      checklist: {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'Task', done: true }],
      },
    } as any);

    const done = () => (cache.get('/todo') as any).checklist.items[0].done;

    // Toggle OFF (true → false)
    simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), false, 'optimistic: unchecked');

    // Toggle ON immediately (false → true)
    simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), true, 'optimistic: re-checked (double toggle = original)');

    // Server responds for toggle #1 (delayed): done changed to false
    applyServerPatch('/todo', [
      { op: 'replace', path: '/checklist/items/0/done', value: false },
    ]);

    // BUG SCENARIO: without rebase, server "false" overwrites optimistic "true"
    // Correct: confirmed=false, replay toggle #2 → true
    assert.strictEqual(done(), true, 'after server #1: replay toggle ON keeps it checked');
    assert.strictEqual(hasPending('/todo'), true, 'toggle #2 still pending');

    // Server responds for toggle #2: done changed to true
    applyServerPatch('/todo', [
      { op: 'replace', path: '/checklist/items/0/done', value: true },
    ]);
    assert.strictEqual(done(), true, 'confirmed: checked');
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('triple toggle race — each server response replays remaining', () => {
    cache.put({
      $path: '/todo', $type: 'dir',
      checklist: {
        $type: 'test.e2e.checklist',
        items: [{ id: 1, text: 'X', done: false }],
      },
    } as any);

    const done = () => (cache.get('/todo') as any).checklist.items[0].done;

    // 3 rapid toggles: false→true→false→true
    simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), true, 'toggle 1');
    simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), false, 'toggle 2');
    simulateExecute('/todo', 'toggle', { id: 1 }, 'checklist');
    assert.strictEqual(done(), true, 'toggle 3');

    // Server #1: done=true
    applyServerPatch('/todo', [{ op: 'replace', path: '/checklist/items/0/done', value: true }]);
    // confirmed=true, replay toggle→false, toggle→true = true
    assert.strictEqual(done(), true, 'after server #1');

    // Server #2: done=false
    applyServerPatch('/todo', [{ op: 'replace', path: '/checklist/items/0/done', value: false }]);
    // confirmed=false, replay toggle→true
    assert.strictEqual(done(), true, 'after server #2');

    // Server #3: done=true
    applyServerPatch('/todo', [{ op: 'replace', path: '/checklist/items/0/done', value: true }]);
    assert.strictEqual(done(), true, 'after server #3');
    assert.strictEqual(hasPending('/todo'), false);
  });

  it('frozen cache objects dont break rebase', () => {
    // cache.put freezes in dev mode — verify structuredClone unfreezes properly
    const node = { $path: '/c', $type: 'test.e2e.counter', count: 0 } as any;
    cache.put(node);

    // In dev mode, cache.get returns frozen object
    const cached = cache.get('/c');
    if (cached && Object.isFrozen(cached)) {
      // structuredClone in pushOptimistic should produce unfrozen copy
      simulateExecute('/c', 'increment', undefined);
      assert.strictEqual((cache.get('/c') as any).count, 1, 'works with frozen cache');

      applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 1 }]);
      assert.strictEqual(hasPending('/c'), false);
    } else {
      // Not frozen (prod mode) — just verify basic flow
      simulateExecute('/c', 'increment', undefined);
      assert.strictEqual((cache.get('/c') as any).count, 1);
      applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 1 }]);
      assert.strictEqual(hasPending('/c'), false);
    }
  });
});
