// Universal watch() token threading (core-anz4.28 slice 0):
// registration carries the tab token, and the generator's teardown releases
// the SERVER hold (not just the cache subscription) — refcounted, so a
// co-consuming generator on the same path survives the first one's return.
//
// Run: npm test (tsx --import test/register-dom.mjs --experimental-test-module-mocks)

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeData } from '@treenx/core';

const getCalls: Record<string, unknown>[] = [];
const unwatchCalls: Record<string, unknown>[] = [];
const getQuery = mock.fn(async (input: { path: string }): Promise<NodeData> => {
  getCalls.push(input);
  return { $path: input.path, $type: 'doc', v: 1 };
});
const unwatchMutate = mock.fn(async (input: Record<string, unknown>) => {
  unwatchCalls.push(input);
});

// Mock the trpc singleton before importing hooks — same resolved URL serves
// '#tree/trpc' and './trpc', so one mock covers all importers.
mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: getQuery },
      getChildren: { query: async () => ({ items: [], total: 0 }) },
      patch: { mutate: async () => {} },
      set: { mutate: async () => {} },
      remove: { mutate: async () => {} },
      execute: { mutate: async () => undefined },
      unwatch: { mutate: unwatchMutate },
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

const { watch } = await import('#hooks');
const cache = await import('#tree/cache');

beforeEach(() => {
  cache.clear();
  getCalls.length = 0;
  unwatchCalls.length = 0;
  getQuery.mock.resetCalls();
  unwatchMutate.mock.resetCalls();
});

describe('universal watch() — server-hold lifecycle (anz4.28)', () => {
  it('registers with the tab token and releases the server hold on return', async () => {
    const gen = watch('/w1');
    const first = await gen.next();
    assert.equal(first.done, false, 'initial snapshot yielded');
    assert.deepEqual(getCalls, [{ path: '/w1', watch: true, token: 'test-tab' }]);
    assert.equal(unwatchMutate.mock.callCount(), 0);

    await gen.return(undefined);
    assert.deepEqual(unwatchCalls, [{ paths: ['/w1'], token: 'test-tab' }]);
  });

  it('co-held path: first generator return keeps the hold, last one releases exactly once', async () => {
    const g1 = watch('/w2');
    await g1.next();
    const g2 = watch('/w2');
    await g2.next();

    await g1.return(undefined);
    assert.equal(unwatchMutate.mock.callCount(), 0, 'hold survives while a co-consumer lives');

    await g2.return(undefined);
    assert.deepEqual(unwatchCalls, [{ paths: ['/w2'], token: 'test-tab' }]);
  });

  it('failed registration releases nothing — no phantom unwatch', async () => {
    getQuery.mock.mockImplementationOnce(async () => { throw new Error('FORBIDDEN'); });
    const gen = watch('/w3');
    await assert.rejects(() => gen.next(), /FORBIDDEN/);
    assert.equal(unwatchMutate.mock.callCount(), 0);
  });

  it('initial get ingests through rebase — an older wire image cannot regress a newer cached one (ns6p.4 F2, inv.18)', async () => {
    cache.put({ $path: '/w5', $type: 'doc', $rev: 5, v: 'newer' });
    getQuery.mock.mockImplementationOnce(async (input: { path: string }) =>
      ({ $path: input.path, $type: 'doc', $rev: 1, v: 'stale' }));

    const gen = watch('/w5');
    await gen.next();

    assert.equal(cache.get('/w5')?.$rev, 5, 'raw put would have regressed the node to the stale image');
    await gen.return(undefined);
  });
});
