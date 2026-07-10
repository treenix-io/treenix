// ClientTreeSource pagination contract: every listing resumes via nextCursor.

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeData } from '@treenx/core';

type WirePage = { items: NodeData[]; total: number; truncated?: boolean; nextCursor?: string };

// Scripted pages consumed in order; every call is recorded for input asserts.
const getChildrenCalls: Record<string, unknown>[] = [];
let pages: WirePage[] = [];
const getChildrenQuery = mock.fn(async (input: Record<string, unknown>) => {
  getChildrenCalls.push(input);
  const page = pages.shift();
  if (!page) throw new Error('getChildren called with no scripted page');
  return page;
});

// Mock the trpc singleton before importing the source — same resolved URL
// serves '#tree/trpc' and './trpc', so one mock covers all importers.
mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: async () => undefined },
      getChildren: { query: getChildrenQuery },
      patch: { mutate: async () => {} },
      set: { mutate: async () => {} },
      remove: { mutate: async () => {} },
      execute: { mutate: async () => undefined },
      unwatch: { mutate: async () => {} },
      unwatchChildren: { mutate: async () => {} },
    },
    getToken: () => null,
    setToken: () => {},
    clearToken: () => {},
    AUTH_EXPIRED_EVENT: 'trpc:auth-expired',
  },
});

const { createClientTreeSource } = await import('./client-tree-source');
const cache = await import('#tree/cache');

const node = (path: string): NodeData => ({ $path: path, $type: 'doc' });

/** Event-driven settle: resolve when the parent's phase reaches `phase`. */
function waitPhase(path: string, phase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const p = cache.getChildrenPhase(path);
      if (p === phase) { unsub(); resolve(); }
      else if (p === 'error') { unsub(); reject(cache.getChildrenError(path)); }
    };
    const unsub = cache.subscribeChildren(path, check);
    check();
  });
}

beforeEach(() => {
  cache.clear();
  getChildrenCalls.length = 0;
  pages = [];
});

describe('ClientTreeSource — cursor pagination (core-92z)', () => {
  it('query view: stores nextCursor, loadMore resumes via cursor, stops at end', async () => {
    pages = [
      { items: [node('/q/a'), node('/q/b')], total: 2, nextCursor: 'cur-b' },
      { items: [node('/q/c')], total: 1 },
    ];
    const source = createClientTreeSource();
    const h = source.mountChildren('/q', { query: { status: 'open' }, limit: 2 });
    await waitPhase('/q', 'ready');

    assert.deepEqual(getChildrenCalls[0].query, { status: 'open' });
    assert.equal(getChildrenCalls[0].cursor, undefined);
    assert.equal(source.getChildrenSnapshot('/q').nextCursor, 'cur-b');

    h.loadMore();
    await waitPhase('/q', 'ready');

    assert.equal(getChildrenCalls.length, 2);
    assert.equal(getChildrenCalls[1].cursor, 'cur-b');
    assert.deepEqual(getChildrenCalls[1].query, { status: 'open' });
    assert.deepEqual(cache.getChildren('/q').map(n => n.$path), ['/q/a', '/q/b', '/q/c']);
    assert.equal(source.getChildrenSnapshot('/q').nextCursor, null);
    // total tracks loaded count, not a per-page value
    assert.equal(source.getChildrenSnapshot('/q').total, 3);

    // Exhausted view: loadMore is a no-op.
    h.loadMore();
    assert.equal(getChildrenCalls.length, 2);
    h.dispose();
  });

  it('query mount (no caller query): server-issued nextCursor still drives loadMore', async () => {
    pages = [
      { items: [node('/view/a')], total: 1, nextCursor: 'cur-a' },
      { items: [node('/view/b')], total: 1 },
    ];
    const source = createClientTreeSource();
    const h = source.mountChildren('/view', { limit: 1 });
    await waitPhase('/view', 'ready');

    h.loadMore();
    await waitPhase('/view', 'ready');

    assert.equal(getChildrenCalls[1].cursor, 'cur-a');
    assert.deepEqual(cache.getChildren('/view').map(n => n.$path), ['/view/a', '/view/b']);
    h.dispose();
  });

  it('plain listing: loadMore resumes via the server cursor', async () => {
    pages = [
      { items: [node('/p/a'), node('/p/b')], total: 2, nextCursor: 'cur-b' },
      { items: [node('/p/c'), node('/p/d')], total: 2 },
    ];
    const source = createClientTreeSource();
    const h = source.mountChildren('/p', { limit: 2 });
    await waitPhase('/p', 'ready');

    h.loadMore();
    await waitPhase('/p', 'ready');

    assert.equal(getChildrenCalls[1].cursor, 'cur-b');
    assert.deepEqual(cache.getChildren('/p').map(n => n.$path), ['/p/a', '/p/b', '/p/c', '/p/d']);

    // fully loaded — no further calls
    h.loadMore();
    assert.equal(getChildrenCalls.length, 2);
    h.dispose();
  });

  it('refetch restarts the listing without a cursor', async () => {
    pages = [
      { items: [node('/q2/a')], total: 1 },
      { items: [node('/q2/a')], total: 1 },
    ];
    const source = createClientTreeSource();
    const h = source.mountChildren('/q2', { query: { status: 'open' }, limit: 1 });
    await waitPhase('/q2', 'ready');

    h.refetch();
    await waitPhase('/q2', 'ready');

    assert.equal(getChildrenCalls.length, 2);
    assert.equal(getChildrenCalls[1].cursor, undefined);
    assert.deepEqual(getChildrenCalls[1].query, { status: 'open' });
    h.dispose();
  });
});
