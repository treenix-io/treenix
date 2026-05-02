// Smoke test for the htmlHandler hook on createHttpServer.
// Verifies request flow ordering: routeRegistry → tRPC → htmlHandler → static fallback.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTree } from '#tree';
import { createPipeline, createHttpServer, type HtmlHandler } from './server';
import type { Server } from 'node:http';

async function start(handler: HtmlHandler | undefined): Promise<{ server: Server; url: string }> {
  const pipeline = createPipeline(createMemoryTree());
  const server = createHttpServer(pipeline, { htmlHandler: handler });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('htmlHandler hook', () => {
  it('serves the htmlHandler response when it returns a body', async () => {
    const handler: HtmlHandler = async () => ({
      status: 200,
      headers: { 'Content-Type': 'text/html', 'X-Test': 'ssr' },
      body: '<!doctype html><h1>SSR</h1>',
    });
    const { server, url } = await start(handler);
    try {
      const res = await fetch(`${url}/about`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-test'), 'ssr');
      assert.equal(await res.text(), '<!doctype html><h1>SSR</h1>');
    } finally {
      server.close();
    }
  });

  it('falls through when handler returns null (404 since no static dir)', async () => {
    const handler: HtmlHandler = async () => null;
    const { server, url } = await start(handler);
    try {
      const res = await fetch(`${url}/about`);
      // No static dir + no handler match → no body sent → connection closes; tRPC fallback hits with bad path
      // Either 404 or tRPC error path — both are non-200 and prove handler did NOT take over.
      assert.notEqual(res.status, 200);
    } finally {
      server.close();
    }
  });

  it('does not run for /trpc/* paths', async () => {
    let called = false;
    const handler: HtmlHandler = async () => {
      called = true;
      return { status: 200, headers: {}, body: 'should-not-see' };
    };
    const { server, url } = await start(handler);
    try {
      // tRPC will reject this as a malformed path, but the handler must NOT be invoked.
      await fetch(`${url}/trpc/some.unknown.proc`).catch(() => {});
      assert.equal(called, false);
    } finally {
      server.close();
    }
  });

  it('returns 500 + no-store when handler throws', async () => {
    const handler: HtmlHandler = async () => {
      throw new Error('boom');
    };
    const { server, url } = await start(handler);
    try {
      const res = await fetch(`${url}/about`);
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
      server.close();
    }
  });

  it('skipped entirely when no htmlHandler is configured', async () => {
    const { server, url } = await start(undefined);
    try {
      const res = await fetch(`${url}/about`);
      // No handler, no static dir → some non-200 response. Just verifying we don't crash.
      assert.notEqual(res.status, 500);
    } finally {
      server.close();
    }
  });
});
