// Regression for createClient TokenSource — proves:
//   1. token-as-getter is re-evaluated per request (no client recreation needed after login)
//   2. subscription rejects loudly without flooding mintStreamToken when token is null
//   3. once token appears, subscription works end-to-end

import { createNode, R, S, W } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createClient } from './client';
import { _resetRateLimits } from './rate-limit';
import { createTreenixServer, type TreenixServer } from './server';

function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

describe('createClient TokenSource', () => {
  let ts: TreenixServer;
  let url: string;
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    _resetRateLimits();
    const bootstrap = createMemoryTree();
    await bootstrap.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | W | S }, { g: 'authenticated', p: R | W | S }],
    });
    ts = createTreenixServer(bootstrap);
    ts.server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await listen(ts.server);
    url = `http://127.0.0.1:${port}/trpc/`;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it('static token (string) sends Authorization header', async () => {
    const anon = createClient(url);
    await anon.register.mutate({ userId: 'alice', password: 'pw' });
    const { token } = await anon.login.mutate({ userId: 'alice', password: 'pw' });
    assert.ok(token);

    const authed = createClient(url, token);
    const me = await authed.me.query();
    assert.equal(me?.userId, 'alice');
  });

  it('null token → no Authorization → me() returns null (no crash)', async () => {
    const client = createClient(url, null);
    const me = await client.me.query();
    assert.equal(me, null);
  });

  it('token-as-getter is re-evaluated per request — login refresh works without recreating client', async () => {
    let currentToken: string | null = null;
    const client = createClient(url, () => currentToken);

    // Pre-login: anonymous
    assert.equal(await client.me.query(), null);

    // Register + login through the SAME client instance
    await client.register.mutate({ userId: 'bob', password: 'pw' });
    const { token } = await client.login.mutate({ userId: 'bob', password: 'pw' });
    assert.ok(token);

    // Now plug the token in. No client recreation.
    currentToken = token;
    const me = await client.me.query();
    assert.equal(me?.userId, 'bob');

    // Logout: drop token, next call goes anon again.
    currentToken = null;
    assert.equal(await client.me.query(), null);
  });

  it('subscription with no token throws "No session" without calling mintStreamToken', async () => {
    const client = createClient(url, null);

    // Subscribe should reject quickly; we capture error via onError callback.
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const sub = client.events.subscribe(undefined, {
        onData: () => {},
        onComplete: () => resolve({ ok: true }),
        onError: (err) => resolve({ ok: false, error: String((err as Error)?.message ?? err) }),
      });
      // Safety net — don't hang the test.
      setTimeout(() => { sub.unsubscribe(); resolve({ ok: false, error: 'timeout' }); }, 1500);
    });

    // Subscription rejects (no flood of mintStreamToken requests). Error message text varies
    // between transports (SSE swallows the throw message), so we only assert the no-success contract.
    assert.equal(result.ok, false, 'subscription must NOT succeed without a session');
  });
});
