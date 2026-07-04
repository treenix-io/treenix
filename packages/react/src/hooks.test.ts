// Regression tests for client mutators (core-cnr.5):
// C42 — addComponent/removeComponent roll back the optimistic cache on server reject.
// C47 — moveNode strips $rev and writes destination BEFORE removing the source.
//
// Run: npm test (tsx --import test/register-dom.mjs --experimental-test-module-mocks)

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock the trpc singleton before importing hooks — same resolved URL serves
// '#tree/trpc', './trpc' (remote-tree, schema-loader), so one mock covers all.
const patchMutate = mock.fn(async (_: { path: string; ops: unknown[] }) => {});
const setMutate = mock.fn(async (_: { node: Record<string, unknown> }) => {});
const removeMutate = mock.fn(async (_: { path: string }) => {});
mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: async () => undefined },
      getChildren: { query: async () => ({ items: [], total: 0 }) },
      patch: { mutate: patchMutate },
      set: { mutate: setMutate },
      remove: { mutate: removeMutate },
      execute: { mutate: async () => undefined },
    },
    getToken: () => null,
    setToken: () => {},
    clearToken: () => {},
    AUTH_EXPIRED_EVENT: 'trpc:auth-expired',
  },
});

const { addComponent, removeComponent, moveNode } = await import('#hooks');
const cache = await import('#tree/cache');
const { tree } = await import('#tree/client');
const { makeNode } = await import('@treenx/core');

beforeEach(() => {
  patchMutate.mock.resetCalls();
  setMutate.mock.resetCalls();
  removeMutate.mock.resetCalls();
  cache.clear();
});

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
