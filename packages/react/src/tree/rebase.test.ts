// Rebase tests — confirmed + pending + replay

import { getCtx, registerType } from '@treenx/core/comp';
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

// core-anz4.18: standard mod actions read getCtx() — no server ALS runtime here,
// exactly the browser situation.
class Doc {
  title = '';
  local = 0;

  rename(data: { title: string }) {
    const { node } = getCtx();
    node.title = data.title;
  }

  publish() {
    this.local++; // mutates BEFORE touching server-only ctx
    const { tree } = getCtx();
    void tree;
  }

  async publishLater() {
    this.local++; // sync-span mutation, then await, then server-only ctx
    await Promise.resolve();
    const { tree } = getCtx();
    void tree;
  }

  // Conforming PromiseLike carries ONLY .then — no .catch (core-anz4.18 round 3).
  thenableResolve() {
    this.local++;
    return { then(res?: (v: unknown) => void) { res?.(undefined); } };
  }

  thenableReject() {
    this.local++;
    return { then(_res?: (v: unknown) => void, rej?: (e: unknown) => void) { rej?.(new Error('boom')); } };
  }
}
registerType('test.rebase.doc', Doc);

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

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'op1');
    assert.strictEqual((cache.get('/c') as any).count, 6, 'optimistic applied');

    // Server patch echoes our opId as `by` — this ack confirms op1
    applyServerPatch('/c', [['r', 'count', 6 ]], undefined, 'op1');
    assert.strictEqual((cache.get('/c') as any).count, 6, 'server confirmed');
    assert.strictEqual(hasPending('/c'), false, 'cleaned up');
  });

  it('server enriches data beyond optimistic prediction', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'op1');
    assert.strictEqual((cache.get('/c') as any).count, 6);
    assert.strictEqual((cache.get('/c') as any).updatedBy, undefined, 'client has no enrichment');

    // Server sets count=6 AND adds updatedBy field
    applyServerPatch('/c', [
      ['r', 'count', 6 ],
      ['a', 'updatedBy', 'server' ],
    ], undefined, 'op1');
    const node = cache.get('/c') as any;
    assert.strictEqual(node.count, 6);
    assert.strictEqual(node.updatedBy, 'server', 'server enrichment preserved');
  });

  it('named component key', () => {
    cache.put({
      $path: '/n', $type: 'dir',
      '#stats': { $type: 'test.rebase.counter', count: 3 },
    } as any);

    pushOptimistic('/n', Counter, 'stats', action('test.rebase.counter', 'increment'), undefined, 'op1');
    assert.strictEqual((cache.get('/n') as any)['#stats'].count, 4);

    applyServerPatch('/n', [['r', '#stats.count', 4 ]], undefined, 'op1');
    assert.strictEqual((cache.get('/n') as any)['#stats'].count, 4);
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
    pushOptimistic('/t', Checklist, undefined, toggleFn, { id: 1 }, 'op1');
    pushOptimistic('/t', Checklist, undefined, toggleFn, { id: 2 }, 'op2');
    pushOptimistic('/t', Checklist, undefined, toggleFn, { id: 3 }, 'op3');

    const items = () => (cache.get('/t') as any).items;
    assert.strictEqual(items()[0].done, true, 'all 3 optimistic');
    assert.strictEqual(items()[1].done, true);
    assert.strictEqual(items()[2].done, true);

    // Server confirms toggle 1
    applyServerPatch('/t', [['r', 'items.0.done', true ]], undefined, 'op1');
    assert.strictEqual(items()[0].done, true, 'confirmed + replayed');
    assert.strictEqual(items()[1].done, true, 'still optimistic');
    assert.strictEqual(items()[2].done, true, 'still optimistic');
    assert.strictEqual(hasPending('/t'), true);

    // Server confirms toggle 2
    applyServerPatch('/t', [['r', 'items.1.done', true ]], undefined, 'op2');
    assert.strictEqual(items()[1].done, true);
    assert.strictEqual(hasPending('/t'), true);

    // Server confirms toggle 3
    applyServerPatch('/t', [['r', 'items.2.done', true ]], undefined, 'op3');
    assert.strictEqual(items()[2].done, true);
    assert.strictEqual(hasPending('/t'), false, 'all confirmed, cleaned up');
  });

  it('rollback restores confirmed state', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'op1');
    assert.strictEqual((cache.get('/c') as any).count, 6);

    rollback('/c', 'op1');
    assert.strictEqual((cache.get('/c') as any).count, 5, 'reverted to confirmed');
    assert.strictEqual(hasPending('/c'), false);
  });

  it('rollback targets the failed op by id, not position (cnr.6 regression)', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    const incFn = action('test.rebase.counter', 'increment');
    pushOptimistic('/c', Counter, undefined, incFn, undefined, 'a'); // count=6
    pushOptimistic('/c', Counter, undefined, incFn, undefined, 'b'); // count=7
    assert.strictEqual((cache.get('/c') as any).count, 7);

    // The HEAD op fails — blind pop() would wrongly drop 'b' instead.
    rollback('/c', 'a');
    assert.strictEqual((cache.get('/c') as any).count, 6, 'head removed, b replayed on base');
    assert.strictEqual(hasPending('/c'), true, 'b still pending');

    applyServerPatch('/c', [['r', 'count', 6 ]], undefined, 'b');
    assert.strictEqual(hasPending('/c'), false);
  });

  it('foreign write (no by) does not consume our pending op (cnr.6 regression)', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', $rev: 1, count: 5 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'mine');
    assert.strictEqual((cache.get('/c') as any).count, 6, 'optimistic +1');

    // Another user writes the same node — the event carries no `by` of ours.
    // Blind FIFO shift would eat our pending slot here (the cnr.6 bug).
    applyServerPatch('/c', [['r', 'count', 50 ]], 2, undefined);
    assert.strictEqual((cache.get('/c') as any).count, 51, 'foreign confirmed(50) + our pending +1');
    assert.strictEqual(hasPending('/c'), true, 'our op survived the foreign write');

    // Our own ack finally arrives (server applied our +1 atop 50).
    applyServerPatch('/c', [['r', 'count', 51 ]], 3, 'mine');
    assert.strictEqual(hasPending('/c'), false, 'matching by consumed our op');
    assert.strictEqual((cache.get('/c') as any).count, 51);
  });

  it('applyServerPatch returns false when no rebase state', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);
    const handled = applyServerPatch('/c', [['r', 'count', 10 ]]);
    assert.strictEqual(handled, false);
  });

  it('applyServerSet replaces confirmed and replays remaining', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', count: 5 } as any);

    const incFn = action('test.rebase.counter', 'increment');
    pushOptimistic('/c', Counter, undefined, incFn, undefined, 'op1'); // count=6
    pushOptimistic('/c', Counter, undefined, incFn, undefined, 'op2'); // count=7

    // Server sends full node (set event) confirming first action
    applyServerSet('/c', { $path: '/c', $type: 'test.rebase.counter', count: 6, extra: 'data' } as any, 'op1');

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

      pushOptimistic('/c', Counter, undefined, incFn, undefined, 'op1');    // count=6
      pushOptimistic('/c', Counter, undefined, brokenFn, undefined, 'op2'); // throws, skipped
      pushOptimistic('/c', Counter, undefined, incFn, undefined, 'op3');    // count=7

      assert.strictEqual((cache.get('/c') as any).count, 7);

      // Server confirms first
      applyServerPatch('/c', [['r', 'count', 6 ]], undefined, 'op1');
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
        'op1',
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

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'op1');
    assert.strictEqual(hasPending('/c'), true);

    applyServerPatch('/c', [['r', 'count', 1 ]], undefined, 'op1');
    assert.strictEqual(hasPending('/c'), false, 'state map cleaned up');
  });

  it('applyServerPatch updates confirmed $rev from event.rev (regression for OCC storm)', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', $rev: 1, count: 0 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'op1');
    // While pending, server confirms with new rev
    applyServerPatch('/c', [['r', 'count', 1 ]], 2, 'op1');

    const node = cache.get('/c') as any;
    assert.strictEqual(node.$rev, 2, 'confirmed $rev advanced to server rev (was stale → OCC storm before fix)');
  });

  it('continuity loss drops overlays — lost ack must not zombie-replay (core-jvfv)', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', $rev: 1, count: 5 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'lost');
    assert.strictEqual((cache.get('/c') as any).count, 6, 'optimistic applied');

    // The write LANDED server-side, but its ack event fell into an SSE gap and
    // the reconnect answered preserved:false — events.ts drops all overlays.
    clear();
    assert.strictEqual(hasPending('/c'), false, 'no pending survives continuity loss');

    // Refetch is authoritative: server shows our landed write.
    cache.put({ $path: '/c', $type: 'test.rebase.counter', $rev: 2, count: 6 } as any);

    // Next event on the path must route through the normal cache path — with a
    // surviving overlay this would replay stale confirmed(5)+1 over fresh data.
    assert.strictEqual(
      applyServerPatch('/c', [['r', 'count', 60 ]], 3, undefined), false,
      'rebase does not handle events after reset',
    );
    assert.strictEqual((cache.get('/c') as any).count, 6, 'refetched truth intact, no stale replay');
  });

  it('getCtx().node action predicts client-side without server runtime (core-anz4.18)', () => {
    cache.put({ $path: '/doc', $type: 'test.rebase.doc', title: 'old', local: 0 } as any);

    pushOptimistic('/doc', Doc, undefined, action('test.rebase.doc', 'rename'), { title: 'new' }, 'op1');
    assert.strictEqual((cache.get('/doc') as any).title, 'new', 'prediction applied');

    applyServerPatch('/doc', [['r', 'title', 'new']], undefined, 'op1');
    assert.strictEqual((cache.get('/doc') as any).title, 'new', 'server confirmed');
    assert.strictEqual(hasPending('/doc'), false);
  });

  it('server-only ctx access skips prediction atomically — no half-applied draft (core-anz4.18)', () => {
    cache.put({ $path: '/doc', $type: 'test.rebase.doc', title: 'old', local: 0 } as any);

    pushOptimistic('/doc', Doc, undefined, action('test.rebase.doc', 'publish'), undefined, 'op1');
    // publish() mutated `local` before hitting ctx.tree — that mutation must not leak
    assert.strictEqual((cache.get('/doc') as any).local, 0, 'no half-executed prediction in cache');
    assert.strictEqual(hasPending('/doc'), true, 'op still pending — server round-trip settles it');

    applyServerPatch('/doc', [['r', 'local', 1]], undefined, 'op1');
    assert.strictEqual((cache.get('/doc') as any).local, 1, 'server result authoritative');
    assert.strictEqual(hasPending('/doc'), false);
  });

  it('async prediction never commits — sync-span mutation must not leak (core-anz4.18)', async () => {
    cache.put({ $path: '/doc', $type: 'test.rebase.doc', title: 'old', local: 0 } as any);

    pushOptimistic('/doc', Doc, undefined, action('test.rebase.doc', 'publishLater'), undefined, 'op1');
    assert.strictEqual((cache.get('/doc') as any).local, 0, 'thenable candidate discarded at push');
    assert.strictEqual(hasPending('/doc'), true);

    // Drain microtasks: post-await rejection + its .catch handler
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual((cache.get('/doc') as any).local, 0, 'no mutation leaked after settlement');

    applyServerPatch('/doc', [['r', 'local', 1]], undefined, 'op1');
    assert.strictEqual((cache.get('/doc') as any).local, 1, 'server result authoritative');
    assert.strictEqual(hasPending('/doc'), false);
  });

  it('then-only thenables (no .catch) skip cleanly — resolution silent, rejection reported (core-anz4.18)', async () => {
    cache.put({ $path: '/doc', $type: 'test.rebase.doc', title: 'old', local: 0 });

    const clean = await captureWarnings(async () => {
      pushOptimistic('/doc', Doc, undefined, action('test.rebase.doc', 'thenableResolve'), undefined, 'op1');
      assert.strictEqual(cache.get('/doc')?.local, 0, 'candidate discarded');
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.strictEqual(clean.length, 0, 'clean resolution reports nothing');

    const warned = await captureWarnings(async () => {
      pushOptimistic('/doc', Doc, undefined, action('test.rebase.doc', 'thenableReject'), undefined, 'op2');
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.strictEqual(cache.get('/doc')?.local, 0, 'rejecting thenable also discarded');
    assert.strictEqual(warned.length, 1, 'rejection reported once, not orphaned');
  });

  it('applyServerPatch ignores non-finite rev (wire garbage)', () => {
    cache.put({ $path: '/c', $type: 'test.rebase.counter', $rev: 5, count: 0 } as any);

    pushOptimistic('/c', Counter, undefined, action('test.rebase.counter', 'increment'), undefined, 'op1');
    applyServerPatch('/c', [['r', 'count', 1 ]], Number.NaN, 'op1');

    const node = cache.get('/c') as any;
    assert.strictEqual(node.$rev, 5, 'NaN rev did not corrupt cached $rev');
  });
});
