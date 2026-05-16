// Rebase tests — confirmed + pending + replay

import { registerType } from '@treenx/core/comp';
import { resolve } from '@treenx/core';
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import * as cache from './cache';
import { applyServerPatch, applyServerSet, clear, hasPending, pushOptimistic, rollback } from './rebase';

// ── Test types ──

class Counter {
  count = 0;
  increment() { this.count++; }
  broken() { throw new Error('fail'); }
}
registerType('test.rebase.counter', Counter);

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
registerType('test.rebase.checklist', Checklist);

const action = (type: string, name: string) => resolve(type, `action:${name}`, false)!;

afterEach(() => { cache.clear(); clear(); });

async function captureWarnings(fn: (warnings: string[]) => void | Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    await fn(warnings);
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

// ── Tests ──

describe('rebase', () => {

  it('single action → patch → confirmed', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined);
    assert.strictEqual((cache.get('/c') as any).count, 6, 'optimistic applied');

    // Server patch: count 5 → 6
    applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 6 }]);
    assert.strictEqual((cache.get('/c') as any).count, 6, 'server confirmed');
    assert.strictEqual(hasPending('/c'), false, 'cleaned up');
  });

  it('server enriches data beyond optimistic prediction', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined);
    assert.strictEqual((cache.get('/c') as any).count, 6);
    assert.strictEqual((cache.get('/c') as any).updatedBy, undefined, 'client has no enrichment');

    // Server sets count=6 AND adds updatedBy field
    applyServerPatch('/c', [
      { op: 'replace', path: '/count', value: 6 },
      { op: 'add', path: '/updatedBy', value: 'server' },
    ]);
    const node = cache.get('/c') as any;
    assert.strictEqual(node.count, 6);
    assert.strictEqual(node.updatedBy, 'server', 'server enrichment preserved');
  });

  it('named component key', () => {
    cache.put({
      $path: '/n', $type: 'dir',
      stats: { $type: 'test.rebase.counter', count: 3 },
    } as any);

    pushOptimistic('/n', Counter, 'stats', action('test.rebase.counter', 'increment'), undefined);
    assert.strictEqual((cache.get('/n') as any).stats.count, 4);

    applyServerPatch('/n', [{ op: 'replace', path: '/stats/count', value: 4 }]);
    assert.strictEqual((cache.get('/n') as any).stats.count, 4);
    assert.strictEqual(hasPending('/n'), false);
  });

  it('3 rapid actions → patches arrive in order', () => {
    cache.put({
      $path: '/t', $type: 'test.rebase.checklist',
      items: [
        { id: 1, text: 'a', done: false },
        { id: 2, text: 'b', done: false },
        { id: 3, text: 'c', done: false },
      ],
    } as any);

    const toggleFn = action('test.rebase.checklist', 'toggle');

    // 3 rapid toggles
    pushOptimistic('/t', Checklist, undefined, toggleFn, { id: 1 });
    pushOptimistic('/t', Checklist, undefined, toggleFn, { id: 2 });
    pushOptimistic('/t', Checklist, undefined, toggleFn, { id: 3 });

    const items = () => (cache.get('/t') as any).items;
    assert.strictEqual(items()[0].done, true, 'all 3 optimistic');
    assert.strictEqual(items()[1].done, true);
    assert.strictEqual(items()[2].done, true);

    // Server confirms toggle 1
    applyServerPatch('/t', [{ op: 'replace', path: '/items/0/done', value: true }]);
    assert.strictEqual(items()[0].done, true, 'confirmed + replayed');
    assert.strictEqual(items()[1].done, true, 'still optimistic');
    assert.strictEqual(items()[2].done, true, 'still optimistic');
    assert.strictEqual(hasPending('/t'), true);

    // Server confirms toggle 2
    applyServerPatch('/t', [{ op: 'replace', path: '/items/1/done', value: true }]);
    assert.strictEqual(items()[1].done, true);
    assert.strictEqual(hasPending('/t'), true);

    // Server confirms toggle 3
    applyServerPatch('/t', [{ op: 'replace', path: '/items/2/done', value: true }]);
    assert.strictEqual(items()[2].done, true);
    assert.strictEqual(hasPending('/t'), false, 'all confirmed, cleaned up');
  });

  it('rollback restores confirmed state', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined);
    assert.strictEqual((cache.get('/c') as any).count, 6);

    rollback('/c');
    assert.strictEqual((cache.get('/c') as any).count, 5, 'reverted to confirmed');
    assert.strictEqual(hasPending('/c'), false);
  });

  it('rollback with remaining pending replays survivors', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    const incFn = action('test.rebase.counter', 'increment');
    pushOptimistic('/c', Counter, undefined, incFn, undefined); // count=6
    pushOptimistic('/c', Counter, undefined, incFn, undefined); // count=7

    assert.strictEqual((cache.get('/c') as any).count, 7);

    rollback('/c'); // pop second, replay first
    assert.strictEqual((cache.get('/c') as any).count, 6);
    assert.strictEqual(hasPending('/c'), true, 'first op still pending');
  });

  it('applyServerPatch returns false when no rebase state', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);
    const handled = applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 10 }]);
    assert.strictEqual(handled, false);
  });

  it('applyServerSet replaces confirmed and replays remaining', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    const incFn = action('test.rebase.counter', 'increment');
    pushOptimistic('/c', Counter, undefined, incFn, undefined); // count=6
    pushOptimistic('/c', Counter, undefined, incFn, undefined); // count=7

    // Server sends full node (set event) confirming first action
    applyServerSet('/c', { $path: '/c', $type: 'test.rebase.counter', count: 6, extra: 'data' } as any);

    const node = cache.get('/c') as any;
    assert.strictEqual(node.count, 7, 'confirmed(6) + replay increment = 7');
    assert.strictEqual(node.extra, 'data', 'server data preserved through replay');
    assert.strictEqual(hasPending('/c'), true, 'second op still pending');
  });

  it('failed replay op warns, is skipped, and others still applied', async () => {
    await captureWarnings((warnings) => {
      cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

      const incFn = action('test.rebase.counter', 'increment');
      const brokenFn = action('test.rebase.counter', 'broken');

      pushOptimistic('/c', Counter, undefined, incFn, undefined);    // count=6
      pushOptimistic('/c', Counter, undefined, brokenFn, undefined); // throws, skipped
      pushOptimistic('/c', Counter, undefined, incFn, undefined);    // count=7

      assert.strictEqual((cache.get('/c') as any).count, 7);

      // Server confirms first
      applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 6 }]);
      // Remaining: broken (skipped) + increment → confirmed=6, replay: skip broken, +1 = 7
      assert.strictEqual((cache.get('/c') as any).count, 7);
      assert.ok(
        warnings.some(w => w.includes('[treenix] optimistic replay failed path=/c type=Counter')),
        `expected replay warning, saw: ${warnings.join('\n')}`,
      );
    });
  });

  it('async failed replay op warns without an unhandled rejection', async () => {
    await captureWarnings(async (warnings) => {
      cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

      pushOptimistic(
        '/c',
        Counter,
        undefined,
        () => Promise.reject(new Error('async fail')),
        undefined,
        { type: 'test.rebase.counter', action: 'asyncBroken' },
      );
      await Promise.resolve();

      assert.ok(
        warnings.some(w => w.includes('path=/c type=test.rebase.counter action=asyncBroken')),
        `expected async replay warning, saw: ${warnings.join('\n')}`,
      );
    });
  });

  it('cleanup leaves no state in map', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 0 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined);
    assert.strictEqual(hasPending('/c'), true);

    applyServerPatch('/c', [{ op: 'replace', path: '/count', value: 1 }]);
    assert.strictEqual(hasPending('/c'), false, 'state map cleaned up');
  });
});
