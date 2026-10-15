import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { it } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { createTwpHttpServer } from '../../../core/src/server/http-twp';
import { nativeFixture } from '#native-fixture.test';
import { openSsrSession } from '#native-session';
import { ServerTreeSource } from '#server-tree-source';
import { createLaneTreeSource } from '@treenx/react/tree/lane-source';
import { SESSION_COOKIE } from '@treenx/core/security';

it('opens an authenticated SSR request with a cookie and no Origin', async (t) => {
  const { instance, admin, key } = await nativeFixture(t);
  await admin.commit({
    opId: key(),
    changes: [{ op: 'put', node: { $path: '/secret', $type: 't.dir', title: 'cookie-secret' } }],
  });
  const api = createTwpHttpServer({ instance, allowedOrigins: [], credentialTtlMs: 60_000 });
  t.after(() => api.close());
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  const address = api.server.address();
  assert.ok(address !== null && typeof address === 'object');
  assert.ok(instance.setupCredential);
  const socket = new Socket();
  t.after(() => socket.destroy());
  const request = new IncomingMessage(socket);
  request.headers.cookie = `${SESSION_COOKIE}=${instance.setupCredential.token}`;
  const session = await openSsrSession(
    `http://127.0.0.1:${address.port}`,
    request,
    new ServerResponse(request),
  );
  try {
    const result = await session.reader.read({ node: '/secret' });
    assert.equal(result.copies.length, 1);
    assert.ok(!('error' in result.copies[0]));
    assert.equal(result.copies[0].node.title, 'cookie-secret');
    assert.equal(session.private, true);
  } finally {
    session.close();
  }
});

it('preserves refusal of conflicting, empty and duplicate SSR credentials', async (t) => {
  const { instance } = await nativeFixture(t);
  const api = createTwpHttpServer({ instance, allowedOrigins: [], credentialTtlMs: 60_000 });
  t.after(() => api.close());
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  const address = api.server.address();
  assert.ok(address !== null && typeof address === 'object');
  assert.ok(instance.setupCredential);
  const cookie = `${SESSION_COOKIE}=${instance.setupCredential.token}`;
  for (const headers of [
    { cookie, authorization: 'Bearer other-token' },
    { cookie: `${cookie}; ${cookie}` },
    { cookie: `${SESSION_COOKIE}=` },
  ]) {
    const socket = new Socket();
    t.after(() => socket.destroy());
    const request = new IncomingMessage(socket);
    request.headers = headers;
    await assert.rejects(
      () => openSsrSession(`http://127.0.0.1:${address.port}`, request, new ServerResponse(request)),
      (error) => error instanceof KernelError && error.code === 'UNAUTHENTICATED',
    );
  }
});

it('binds real SSR HTTP transport to the incoming credential and closes the request owner', async (t) => {
  const { instance, admin, key } = await nativeFixture(t);
  await admin.commit({
    opId: key(),
    changes: [{ op: 'put', node: { $path: '/secret', $type: 't.dir', title: 'request-secret' } }],
  });
  const api = createTwpHttpServer({ instance, allowedOrigins: [], credentialTtlMs: 60_000 });
  t.after(() => api.close());
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  const address = api.server.address();
  assert.ok(address !== null && typeof address === 'object');
  let closed = 0;
  const front = createServer(async (request, response) => {
    const session = await openSsrSession(`http://127.0.0.1:${address.port}`, request, response);
    try {
      const source = new ServerTreeSource(session.reader);
      source.getPathSnapshot('/secret');
      await source.flushPending();
      const hydration = source.serialize();
      const before = session.reader.cache.copy(hydration.reads[0].result.list[0]);
      const presented = createLaneTreeSource(session.reader, hydration);
      assert.equal(presented.getPathSnapshot('/secret').data?.title, 'request-secret');
      assert.equal(session.reader.cache.copy(hydration.reads[0].result.list[0]), before);
      const handle = presented.mountSelector({ node: '/secret' });
      await new Promise<void>((resolve) => {
        const done = () => {
          if (handle.getSnapshot().generations.length === 0) return;
          unsubscribe();
          resolve();
        };
        const unsubscribe = handle.subscribe(done);
        done();
      });
      assert.equal(presented.getPathSnapshot('/secret').data?.title, 'request-secret');
      handle.dispose();
      presented.close();
      response.setHeader('Cache-Control', session.private ? 'private, no-store' : 'no-store');
      response.end(JSON.stringify(source.serialize()));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    } finally {
      session.close();
      await assert.rejects(
        async () => session.reader.read({ node: '/secret' }),
        (error) => error instanceof KernelError && error.code === 'CANCELLED',
      );
      closed++;
    }
  });
  t.after(() => new Promise<void>((resolve) => front.close(() => resolve())));
  front.listen(0, '127.0.0.1');
  await once(front, 'listening');
  const host = front.address();
  assert.ok(host !== null && typeof host === 'object');
  assert.ok(instance.setupCredential);
  const response = await fetch(`http://127.0.0.1:${host.port}/page`, {
    headers: { Authorization: `Bearer ${instance.setupCredential.token}` },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.ok(body.includes('request-secret'));
  assert.equal(closed, 1);
});
