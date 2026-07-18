// Tab-global hold registry pins (ns6p.4 r2-F5, invariant 2): the server keeps
// ONE hold per (user, tab-token, path) — the unwatch mutation may fire only
// when the LAST tab-wide consumer releases, across ALL mechanisms (source
// mounts, watch() generators, sidebar listings).

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const unwatchCalls: Record<string, unknown>[] = [];
const unwatchChildrenCalls: Record<string, unknown>[] = [];
const unwatchMutate = mock.fn(async (input: Record<string, unknown>) => { unwatchCalls.push(input); });
const unwatchChildrenMutate = mock.fn(async (input: Record<string, unknown>) => { unwatchChildrenCalls.push(input); });

mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: async () => undefined },
      getChildren: { query: async () => ({ items: [], total: 0 }) },
      unwatch: { mutate: unwatchMutate },
      unwatchChildren: { mutate: unwatchChildrenMutate },
    },
    getToken: () => null,
    setToken: () => {},
    clearToken: () => {},
    AUTH_EXPIRED_EVENT: 'trpc:auth-expired',
    TAB_TOKEN: 'test-tab',
    tabTokenInput: { token: 'test-tab' },
  },
});

const holds = await import('./holds');

beforeEach(() => {
  holds.resetHolds();
  unwatchCalls.length = 0;
  unwatchChildrenCalls.length = 0;
  unwatchMutate.mock.resetCalls();
  unwatchChildrenMutate.mock.resetCalls();
});

describe('holds registry — exact co-holds across mechanisms (r2-F5)', () => {
  it('sidebar-style batch release under a live usePath hold: NO unwatch for the co-held child; its last release fires', () => {
    // Sidebar expand counted both children; the Inspector holds /d/a too.
    holds.acquireHolds(['/d/a', '/d/b']);
    holds.acquireHold('/d/a');

    // Collapse: only the path NOBODY else holds is released server-side.
    holds.releaseHolds(['/d/a', '/d/b']);
    assert.deepEqual(unwatchCalls, [{ paths: ['/d/b'], token: 'test-tab' }],
      "collapse must not strip the Inspector's hold on /d/a");

    // Inspector unmount — now the tab-wide count hits zero.
    holds.releaseHold('/d/a');
    assert.deepEqual(unwatchCalls[1], { paths: ['/d/a'], token: 'test-tab' });
  });

  it('batches: one mutation for all last-drop paths of a release', () => {
    holds.acquireHolds(['/b/x', '/b/y']);
    holds.releaseHolds(['/b/x', '/b/y']);
    assert.equal(unwatchMutate.mock.callCount(), 1);
    assert.deepEqual(unwatchCalls, [{ paths: ['/b/x', '/b/y'], token: 'test-tab' }]);
  });

  it('untracked release fires — nothing in this tab holds the path', () => {
    holds.releaseHold('/stray');
    assert.deepEqual(unwatchCalls, [{ paths: ['/stray'], token: 'test-tab' }]);
  });
});

describe('holds registry — children holds (r2-F5)', () => {
  it('sidebar children release under a live useChildren hold: no unwatchChildren until the last consumer', () => {
    holds.acquireChildrenHold('/dir'); // sidebar expand
    holds.acquireChildrenHold('/dir'); // useChildren({watch}) mount

    holds.releaseChildrenHold('/dir'); // sidebar collapse
    assert.equal(unwatchChildrenMutate.mock.callCount(), 0, 'the mount still relies on the prefix hold');

    holds.releaseChildrenHold('/dir'); // mount unmounts
    assert.deepEqual(unwatchChildrenCalls, [{ paths: ['/dir'], token: 'test-tab' }]);
  });
});

describe('holds registry — stray sweep (r2-F5)', () => {
  it('releaseUnheld unwatches only paths with zero tab-wide holds', () => {
    holds.acquireHold('/d/selected'); // e.g. Inspector on an SSE-born child

    holds.releaseUnheld(['/d/selected', '/d/stray1', '/d/stray2']);

    assert.deepEqual(unwatchCalls, [{ paths: ['/d/stray1', '/d/stray2'], token: 'test-tab' }]);
    // The held path still releases normally later.
    holds.releaseHold('/d/selected');
    assert.deepEqual(unwatchCalls[1], { paths: ['/d/selected'], token: 'test-tab' });
  });

  it('empty sweep fires nothing', () => {
    holds.releaseUnheld([]);
    assert.equal(unwatchMutate.mock.callCount(), 0);
  });
});
