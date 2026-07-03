// Tree.watch contract — withSubscriptions integration tests.
// Pins the L1/L3 split (TreeEvent vs NodeEvent), scope filtering (children
// = direct only), and notifyVps wire-stripping. Also covers the PatchOp
// round-trip (sub's fast-json-patch diff → applyOps reconstructs target).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyOps, createMemoryTree, type PatchOp, type TreeEvent } from '#tree';
import type { NodeData } from '#core';
import type { NodeEvent } from './index';
import { withSubscriptions } from './index';

// ── Type-level protocol shape assertions (compile-time) ──
// These force-fail typecheck if VPs leak into L1 or stayVps leaks to L3 public.

// TreeEvent does NOT carry any VP field.
type _Assert_TreeEventHasNoVps = TreeEvent extends { addVps: unknown } ? never
  : TreeEvent extends { rmVps: unknown } ? never
  : TreeEvent extends { stayVps: unknown } ? never
  : TreeEvent extends { invalidateVps: unknown } ? never
  : true;
const _treeEventClean: _Assert_TreeEventHasNoVps = true;
void _treeEventClean;

// NodeEvent extends TreeEvent (assignable both ways at the variant level).
const _treeAsNode: NodeEvent = { type: 'reconnect', preserved: false } as TreeEvent;
void _treeAsNode;

// NodeEvent must NOT have stayVps in its public surface — only addVps/rmVps/invalidateVps.
type _Assert_NodeEventHasNoStayVps = NodeEvent extends { stayVps: unknown } ? never : true;
const _nodeNoStay: _Assert_NodeEventHasNoStayVps = true;
void _nodeNoStay;

describe('Tree.watch — withSubscriptions integration', () => {
  it('children scope yields ONLY direct children (parent + grandchild skipped)', async () => {
    const { tree } = withSubscriptions(createMemoryTree());

    // Seed scope parent
    await tree.set({ $path: '/parent', $type: 'dir' } as NodeData);

    const stream = tree.watch({ kind: 'children', path: '/parent' });
    const it = stream[Symbol.asyncIterator]();

    // Schedule writes after iterator starts
    const collect = (async () => {
      const out: NodeEvent[] = [];
      while (out.length < 1) {
        const { value, done } = await it.next();
        if (done) break;
        out.push(value);
      }
      return out;
    })();

    // Wait one microtask so .next() registers
    await new Promise(r => setImmediate(r));

    // Parent write — NOT a direct child of /parent → must NOT yield
    await tree.set({ $path: '/parent', $type: 'dir', updated: true } as NodeData);
    // Grandchild — descendant but not direct → must NOT yield
    await tree.set({ $path: '/parent/x/grand', $type: 'test' } as NodeData);
    // Direct child — must yield
    await tree.set({ $path: '/parent/y', $type: 'test' } as NodeData);

    const events = await collect;
    await it.return!();

    assert.equal(events.length, 1, 'exactly one event (the direct child write)');
    const e0 = events[0];
    if (e0.type === 'reconnect') throw new Error('unexpected reconnect');
    assert.equal(e0.path, '/parent/y');
  });

  it('path scope yields ONLY exact-path matches', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    await tree.set({ $path: '/x', $type: 'a' } as NodeData);

    const stream = tree.watch({ kind: 'path', path: '/x' });
    const it = stream[Symbol.asyncIterator]();

    const collected: NodeEvent[] = [];
    const pump = (async () => {
      while (collected.length < 1) {
        const { value, done } = await it.next();
        if (done) break;
        collected.push(value);
      }
    })();

    await new Promise(r => setImmediate(r));

    await tree.set({ $path: '/y', $type: 'a' } as NodeData);            // different path — skipped
    await tree.set({ $path: '/x', $type: 'a', n: 1 } as NodeData);      // exact — yields

    await pump;
    await it.return!();

    assert.equal(collected.length, 1);
    const c0 = collected[0];
    if (c0.type === 'reconnect') throw new Error('unexpected reconnect');
    assert.equal(c0.path, '/x');
  });

  it('all scope yields every write', async () => {
    const { tree } = withSubscriptions(createMemoryTree());

    const stream = tree.watch({ kind: 'all' });
    const it = stream[Symbol.asyncIterator]();

    const collected: NodeEvent[] = [];
    const pump = (async () => {
      while (collected.length < 3) {
        const { value, done } = await it.next();
        if (done) break;
        collected.push(value);
      }
    })();

    await new Promise(r => setImmediate(r));

    await tree.set({ $path: '/a', $type: 't' } as NodeData);
    await tree.set({ $path: '/b/nested', $type: 't' } as NodeData);
    await tree.set({ $path: '/c', $type: 't' } as NodeData);

    await pump;
    await it.return!();

    assert.equal(collected.length, 3);
    const paths = collected.map(e => {
      if (e.type === 'reconnect') throw new Error('unexpected reconnect');
      return e.path;
    }).sort();
    assert.deepEqual(paths, ['/a', '/b/nested', '/c']);
  });

  it('patch event carries PatchOp[] (compact tuples, dot paths)', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    await tree.set({ $path: '/n', $type: 't', count: 0 } as NodeData);

    const stream = tree.watch({ kind: 'path', path: '/n' });
    const it = stream[Symbol.asyncIterator]();

    const pump = (async () => {
      const { value, done } = await it.next();
      return done ? null : value;
    })();

    await new Promise(r => setImmediate(r));
    await tree.patch('/n', [['r', 'count', 7]]);

    const event = await pump;
    await it.return!();

    assert.ok(event);
    assert.equal(event.type, 'patch');
    if (event.type === 'patch') {
      assert.deepEqual(event.patches, [['r', 'count', 7]]);
    }
  });

  it('set-with-changes emits diff as PatchOp[] (no fast-json-patch on wire)', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    await tree.set({ $path: '/n', $type: 't', foo: 'old' } as NodeData);

    const stream = tree.watch({ kind: 'path', path: '/n' });
    const it = stream[Symbol.asyncIterator]();

    const pump = (async () => {
      const { value, done } = await it.next();
      return done ? null : value;
    })();

    await new Promise(r => setImmediate(r));
    await tree.set({ $path: '/n', $type: 't', foo: 'new' } as NodeData);

    const event = await pump;
    await it.return!();

    assert.ok(event);
    assert.equal(event.type, 'patch', 'old node existed → set emits diff patch');
    if (event.type === 'patch') {
      // Each entry is a PatchOp tuple, NOT an RFC 6902 {op, path, value} object.
      assert.ok(Array.isArray(event.patches[0]));
      assert.equal(event.patches[0][0], 'r');
      assert.equal(event.patches[0][1], 'foo');
      assert.equal(event.patches[0][2], 'new');
    }
  });
});

describe('PatchOp migration — fjp.compare → fromRfc6902 → applyOps round-trip', () => {
  it('object replace: reconstructs target', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    const oldNode: NodeData = { $path: '/n', $type: 't', a: 1, b: 'hello' };
    const next: NodeData = { $path: '/n', $type: 't', a: 99, b: 'world' };
    await tree.set(oldNode);

    const stream = tree.watch({ kind: 'path', path: '/n' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));
    await tree.set(next);
    const { value: event } = await pump;
    await it.return!();

    assert.ok(event && event.type === 'patch');
    if (event.type === 'patch') {
      const reconstructed: Record<string, unknown> = structuredClone(oldNode) as unknown as Record<string, unknown>;
      applyOps(reconstructed, event.patches);
      // $rev is incremented by the store between set calls — drop it for the shape comparison.
      delete (reconstructed as { $rev?: number }).$rev;
      const expected = { ...next } as Record<string, unknown>;
      delete expected.$rev;
      assert.deepEqual(reconstructed, expected);
    }
  });

  it('nested component change: reconstructs target', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    const oldNode: NodeData = {
      $path: '/n', $type: 't',
      '#counter': { $type: 'cnt', value: 1 },
    };
    const next: NodeData = {
      $path: '/n', $type: 't',
      '#counter': { $type: 'cnt', value: 42 },
    };
    await tree.set(oldNode);

    const stream = tree.watch({ kind: 'path', path: '/n' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));
    await tree.set(next);
    const { value: event } = await pump;
    await it.return!();

    assert.ok(event && event.type === 'patch');
    if (event.type === 'patch') {
      const reconstructed: Record<string, unknown> = structuredClone(oldNode) as unknown as Record<string, unknown>;
      applyOps(reconstructed, event.patches);
      assert.equal((reconstructed['#counter'] as { value: number }).value, 42);
    }
  });

  it('array mutation: reconstructs target', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    const oldNode: NodeData = { $path: '/n', $type: 't', items: [1, 2, 3] };
    const next: NodeData = { $path: '/n', $type: 't', items: [1, 2, 3, 4] };
    await tree.set(oldNode);

    const stream = tree.watch({ kind: 'path', path: '/n' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));
    await tree.set(next);
    const { value: event } = await pump;
    await it.return!();

    assert.ok(event && event.type === 'patch');
    if (event.type === 'patch') {
      const reconstructed: Record<string, unknown> = structuredClone(oldNode) as unknown as Record<string, unknown>;
      applyOps(reconstructed, event.patches);
      assert.deepEqual(reconstructed.items, [1, 2, 3, 4]);
    }
  });

  it('tree.patch round-trip: ops on the wire match ops fed in', async () => {
    const { tree } = withSubscriptions(createMemoryTree());
    await tree.set({ $path: '/n', $type: 't', x: 1, y: 2 } as NodeData);

    const stream = tree.watch({ kind: 'path', path: '/n' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    const ops: PatchOp[] = [
      ['r', 'x', 100],
      ['a', 'z', 'new-field'],
    ];
    await tree.patch('/n', ops);

    const { value: event } = await pump;
    await it.return!();

    assert.ok(event && event.type === 'patch');
    if (event.type === 'patch') {
      assert.deepEqual(event.patches, ops, 'PatchOps pass through unchanged (no RFC 6902 conversion)');
    }
  });
});
