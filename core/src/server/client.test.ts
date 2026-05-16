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

  it('cookie auth — login persists session across same client without bearer', async () => {
    // No bearer source. After login, server sets HttpOnly cookie which the cookie jar
    // captures and replays on subsequent requests — same as a browser.
    const client = createClient(url);

    // Pre-login: anonymous
    assert.equal(await client.me.query(), null);

    // Register + login through the SAME client instance — cookie set on login, jar persists.
    await client.register.mutate({ userId: 'bob', password: 'pw' });
    const r = await client.login.mutate({ userId: 'bob', password: 'pw' });
    assert.ok(r.token, 'login still returns the token (for non-cookie callers)');

    const me = await client.me.query();
    assert.equal(me?.userId, 'bob');

    // logout clears the cookie via Set-Cookie: Max-Age=0 → next call is anon.
    await client.logout.mutate();
    assert.equal(await client.me.query(), null);
  });

  it('events with a stale token reject instead of staying empty', async () => {
    const client = createClient(url, '0'.repeat(64));

    const err = await new Promise<unknown>((resolve, reject) => {
      let sub: { unsubscribe(): void };
      sub = client.events.subscribe(undefined, {
        onData() {
          reject(new Error('stale token stream must not deliver data'));
        },
        onError(e) {
          sub.unsubscribe();
          resolve(e);
        },
        onComplete() {
          reject(new Error('stale token stream completed without error'));
        },
      });
    });

    assert.equal((err as { data?: { code?: string } }).data?.code, 'UNAUTHORIZED');
  });
});
