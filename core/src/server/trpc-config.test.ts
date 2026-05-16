import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTreeRouter,
  SSE_PING_INTERVAL_MS,
  SSE_RECONNECT_AFTER_INACTIVITY_MS,
} from './trpc';
import { createWatchManager } from './watch';

describe('createTreeRouter SSE config', () => {
  it('keeps idle SSE streams alive', () => {
    const router = createTreeRouter(createMemoryTree(), createWatchManager());
    const sse = router._def._config.sse;

    assert.equal(sse?.ping?.enabled, true);
    assert.equal(sse?.ping?.intervalMs, SSE_PING_INTERVAL_MS);
    assert.equal(sse?.client?.reconnectAfterInactivityMs, SSE_RECONNECT_AFTER_INACTIVITY_MS);
    assert.ok(SSE_PING_INTERVAL_MS < SSE_RECONNECT_AFTER_INACTIVITY_MS);
  });
});
