import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTreeRouter,
  SSE_PING_INTERVAL_MS,
  SSE_RECONNECT_AFTER_INACTIVITY_MS,
} from './trpc';
import { createWatchManager } from '#sub/watch';

describe('createTreeRouter SSE config', () => {
  it('keeps idle SSE streams alive', () => {
    const memTree = createMemoryTree();
    const router = createTreeRouter(memTree, memTree, createWatchManager());
    const sse = router._def._config.sse;

    assert.equal(sse?.ping?.enabled, true);
    assert.equal(sse?.ping?.intervalMs, SSE_PING_INTERVAL_MS);
    assert.equal(sse?.client?.reconnectAfterInactivityMs, SSE_RECONNECT_AFTER_INACTIVITY_MS);
    assert.ok(SSE_PING_INTERVAL_MS < SSE_RECONNECT_AFTER_INACTIVITY_MS);
  });

  it('validates unwatch paths with safePath', async () => {
    const memTree = createMemoryTree();
    const router = createTreeRouter(memTree, memTree, createWatchManager());
    const caller = router.createCaller({
      session: { userId: 'u1', claims: ['authenticated'] },
      token: 'token',
      clientIp: null,
    });

    for (const path of ['/../x', '/x/', '/x//y', '/x\0y', '/x\\y', '/x%2fy']) {
      await assert.rejects(() => caller.unwatch({ paths: [path] }));
      await assert.rejects(() => caller.unwatchChildren({ paths: [path] }));
    }
  });
});
