// Regression tests for client mutators (core-cnr.5):
// C42 — addComponent/removeComponent roll back the optimistic cache on server reject.
// C47 — moveNode strips $rev and writes destination BEFORE removing the source.
//
// Run: npm test (tsx --import test/register-dom.mjs --experimental-test-module-mocks)

import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeData } from '@treenx/core';

// Mock the trpc singleton before importing hooks — same resolved URL serves
// '#tree/trpc', './trpc' (remote-tree, schema-loader), so one mock covers all.
const patchMutate = mock.fn(async (_: { path: string; ops: unknown[] }) => {});
const setMutate = mock.fn(async (_: { node: Record<string, unknown> }) => {});
const removeMutate = mock.fn(async (_: { path: string }) => {});
const getQuery = mock.fn(async (_: { path: string }): Promise<NodeData | null | undefined> => undefined);
mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: getQuery },
      getChildren: { query: async () => ({ items: [], total: 0 }) },
      patch: { mutate: patchMutate },
      set: { mutate: setMutate },
      remove: { mutate: removeMutate },
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

const { addComponent, removeComponent, moveNode, set } = await import('#hooks');
const cache = await import('#tree/cache');
const { cancelReadReconverges } = await import('#tree/read-track');
const { tree } = await import('#tree/client');
const { makeNode } = await import('@treenx/core');

beforeEach(() => {
  patchMutate.mock.resetCalls();
  setMutate.mock.resetCalls();
  removeMutate.mock.resetCalls();
  getQuery.mock.resetCalls();
  cache.clear();
});

afterEach(() => cancelReadReconverges());

describe('addComponent / removeComponent — rollback on server reject (C42)', () => {
  it('addComponent rolls the optimistic component back when patch rejects', async () => {
    cache.put(makeNode('/n', 'task', { title: 'x' }));
    patchMutate.mock.mockImplementationOnce(async () => { throw new Error('FORBIDDEN'); });

    await assert.rejects(() => addComponent('/n', 'meta', 'task.meta'), /FORBIDDEN/);

    assert.equal(cache.get('/n')!['#meta'], undefined, 'phantom component rolled back');
  });

  it('addComponent keeps the optimistic component on success', async () => {
    cache.put(makeNode('/n', 'task', { title: 'x' }));

    await addComponent('/n', 'meta', 'task.meta');

    assert.ok(cache.get('/n')!['#meta'], 'optimistic component stays');
    assert.equal(patchMutate.mock.callCount(), 1);
  });

  it('removeComponent restores the component when patch rejects', async () => {
    cache.put(makeNode('/n', 'task', {}, { meta: { $type: 'task.meta', v: 1 } }));
    patchMutate.mock.mockImplementationOnce(async () => { throw new Error('FORBIDDEN'); });

    await assert.rejects(() => removeComponent('/n', 'meta'), /FORBIDDEN/);

    const meta = cache.get('/n')!['#meta'] as { v: number };
    assert.equal(meta.v, 1, 'component restored after reject');
  });
});

describe('set — split failure domains + door-routed refresh (ns6p.4 r3-F1a)', () => {
  it('omits schema versions from each component of a full write without altering the client image', async () => {
    const next: NodeData = { $path: '/versions', $type: 'doc', $v: 1, body: 'current',
      '#note': { $type: 'note', $v: 3, note: 'current' }, snapshot: { $type: 'doc', $v: 7 } };
    const original = structuredClone(next);
    await set(next);
    const sent = setMutate.mock.calls[0].arguments[0].node;
    assert.equal(Object.hasOwn(sent, '$v'), false);
    assert.deepEqual(sent['#note'], { $type: 'note', note: 'current' });
    assert.deepEqual(sent.snapshot, { $type: 'doc', $v: 7 });
    assert.deepEqual(next, original);
  });

  it('write failure still rolls back the optimistic image', async () => {
    cache.put({ $path: '/s1', $type: 'doc', v: 'old' });
    setMutate.mock.mockImplementationOnce(async () => { throw new Error('CONFLICT'); });

    await assert.rejects(() => set({ $path: '/s1', $type: 'doc', v: 'new' }));

    assert.equal((cache.get('/s1') as { v?: string })?.v, 'old', 'write reject rolls back');
  });

  it('refresh failure after a successful write does NOT roll back — loud, non-rolling', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    cache.put({ $path: '/s2', $type: 'doc', v: 'old' });
    getQuery.mock.mockImplementationOnce(async () => { throw new Error('network'); });

    const returned = await set({ $path: '/s2', $type: 'doc', v: 'new' });

    assert.equal((cache.get('/s2') as { v?: string })?.v, 'new',
      'the commit stands — a refresh-only failure must not restore the pre-write image');
    assert.equal((returned as { v?: string }).v, 'new');
    assert.ok(logged.mock.callCount() >= 1, 'refresh failure is loud');
  });

  it('a remove event landing before the refresh response wins — the door does not resurrect', async () => {
    cache.put({ $path: '/s3', $type: 'doc', $rev: 1, v: 'old' });
    let settle!: (n: NodeData) => void;
    getQuery.mock.mockImplementationOnce((_: { path: string }) => new Promise<NodeData>((res) => { settle = res; }));

    const p = set({ $path: '/s3', $type: 'doc', $rev: 1, v: 'new' });
    await new Promise<void>((r) => setImmediate(r)); // write acked; refresh in flight

    // Newer remove event (what applyDataEvent's remove branch does).
    cache.flagPathReadOverlap('/s3');
    cache.remove('/s3');

    settle({ $path: '/s3', $type: 'doc', $rev: 2, v: 'new' });
    await p;

    assert.equal(cache.get('/s3'), undefined, 'a raw put would have resurrected the removed node');
  });
});

describe('moveNode — set destination first, strip $rev (C47)', () => {
  it('moves a $rev-carrying node without OCC CONFLICT (regression: carried rev was rejected at the new path)', async () => {
    // Node lives in the local memory tree AND cache, carrying a server-issued $rev.
    await tree.set({ $path: '/local/mv/a', $type: 'doc', body: 'text' });
    const stored = await tree.get('/local/mv/a');
    assert.ok(stored?.$rev, 'memory tree stamped a rev');
    cache.put(stored!);

    await moveNode('/local/mv/a', '/local/mv/b');

    const moved = await tree.get('/local/mv/b');
    assert.ok(moved, 'destination exists');
    assert.equal(moved!['body'], 'text');
    assert.equal(await tree.get('/local/mv/a'), undefined, 'source removed');
    assert.equal(cache.get('/local/mv/a'), undefined, 'stale cache entry dropped');
  });

  it('keeps the source intact when the destination write fails', async () => {
    await tree.set({ $path: '/local/mv/keep', $type: 'doc' });
    cache.put((await tree.get('/local/mv/keep'))!);
    // Destination outside /local routes to the remote tree — reject it there.
    setMutate.mock.mockImplementationOnce(async () => { throw new Error('deny'); });

    await assert.rejects(() => moveNode('/local/mv/keep', '/remote/keep'));

    assert.ok(await tree.get('/local/mv/keep'), 'source survives failed relocation');
    assert.ok(cache.get('/local/mv/keep'), 'cache entry survives');
  });

  it('throws when the source is not in cache', async () => {
    await assert.rejects(() => moveNode('/local/absent', '/local/other'), /not in cache/);
  });
});
