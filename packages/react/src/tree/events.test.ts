// Exact-path invalidation handling (ns6p.4 §3.4 slice 1): an invalidate with
// `paths` names a held node whose payload was ACL-dropped server-side. The
// client must refetch it through the normal read path; a denied/gone refetch
// EVICTS the entry — keeping it would freeze data the reader may no longer see.

import type { NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as cache from './cache';
import { refetchInvalidatedPath, stopEvents } from './events';

const node = (path: string, v: number): NodeData => ({ $path: path, $type: 't', v });

/** Resolves on the next cache notification for `path` (put or remove). */
function nextCacheChange(path: string): Promise<void> {
  return new Promise((resolve) => {
    const unsub = cache.subscribePath(path, () => {
      unsub();
      resolve();
    });
  });
}

describe('events — refetchInvalidatedPath', () => {
  beforeEach(() => cache.clear());
  afterEach(() => {
    stopEvents(); // clears coalesce timers so no fetch fires into the next test
    mock.restoreAll();
  });

  it('refetches the invalidated node and replaces the cache entry', async () => {
    cache.put(node('/a', 1));
    const changed = nextCacheChange('/a');

    refetchInvalidatedPath('/a', async (path) => node(path, 2));
    await changed;

    assert.equal((cache.get('/a') as { v?: number } | undefined)?.v, 2);
  });

  it('FORBIDDEN refetch: entry evicted, error logged, nothing thrown', async () => {
    const errors = mock.method(console, 'error', () => {});
    cache.put(node('/denied', 1));
    const changed = nextCacheChange('/denied');

    refetchInvalidatedPath('/denied', async () => {
      throw Object.assign(new Error('forbidden'), { data: { code: 'FORBIDDEN' } });
    });
    await changed;

    assert.equal(cache.get('/denied'), undefined, 'stale entry must not survive a denied refetch');
    assert.ok(errors.mock.calls.length >= 1, 'the eviction is loud');
  });

  it('node gone on refetch (null): entry evicted', async () => {
    cache.put(node('/gone', 1));
    const changed = nextCacheChange('/gone');

    refetchInvalidatedPath('/gone', async () => null);
    await changed;

    assert.equal(cache.get('/gone'), undefined);
  });

  it('coalesces a burst of invalidations into one refetch', async () => {
    cache.put(node('/hot', 1));
    const changed = nextCacheChange('/hot');
    let fetches = 0;

    const fetchNode = async (path: string) => {
      fetches++;
      return node(path, 9);
    };
    refetchInvalidatedPath('/hot', fetchNode);
    refetchInvalidatedPath('/hot', fetchNode);
    refetchInvalidatedPath('/hot', fetchNode);
    await changed;

    assert.equal(fetches, 1, 'burst collapses into one fetch');
    assert.equal((cache.get('/hot') as { v?: number } | undefined)?.v, 9);
  });
});
