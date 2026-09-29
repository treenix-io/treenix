import { KernelError } from '#errors';
import type { ErrorCode } from '#kernel/types';
import { createMemoryTree, type Tree } from '#tree';
import { TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
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

// The binding's public translation. Clients branch on these names: the React client signs in again on UNAUTHORIZED.
const TRPC_CODES: Record<ErrorCode, TRPC_ERROR_CODE_KEY> = {
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INVALID: 'BAD_REQUEST',
  UNKNOWN_TYPE: 'BAD_REQUEST',
  CROSS_DOMAIN: 'BAD_REQUEST',
  READ_ONLY: 'METHOD_NOT_SUPPORTED',
  BUDGET: 'TOO_MANY_REQUESTS',
  REFUSED: 'TOO_MANY_REQUESTS',
  UNKNOWN_OUTCOME: 'PRECONDITION_FAILED',
  EXPIRED: 'PRECONDITION_FAILED',
  KEY_REUSED: 'UNPROCESSABLE_CONTENT',
  UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GENERATION: 'PRECONDITION_FAILED',
  CANCELLED: 'CLIENT_CLOSED_REQUEST',
  UNAUTHENTICATED: 'UNAUTHORIZED',
};

function isErrorCode(key: string): key is ErrorCode {
  return Object.hasOwn(TRPC_CODES, key);
}

describe('KernelError over tRPC', () => {
  it('a procedure failing with each kernel code answers its tRPC code', async () => {
    let failWith: ErrorCode = 'NOT_FOUND';
    const memTree = createMemoryTree();
    const failingSystemTree: Tree = { ...memTree, get: async () => { throw new KernelError(failWith, 'store failed'); } };
    const caller = createTreeRouter(memTree, failingSystemTree, createWatchManager()).createCaller({
      session: { userId: 'u1', claims: ['authenticated'] },
      token: 'token',
      clientIp: null,
    });

    for (const [code, trpcCode] of Object.entries(TRPC_CODES)) {
      assert.ok(isErrorCode(code));
      failWith = code;
      await assert.rejects(
        () => caller.login({ userId: `u.${code}`, password: 'pw' }),
        (e: unknown) => e instanceof TRPCError && e.code === trpcCode,
        code,
      );
    }
  });
});
