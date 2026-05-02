// End-to-end smoke: HTTP server + htmlHandler + ssrHandler + RouteIndex.
// Demonstrates the full Phase 3 pipeline without Vite (Phase 5 wires that).

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '@treenx/core';
import type { NodeData } from '@treenx/core';
import { createMemoryTree } from '@treenx/core/tree';
import { createPipeline, createHttpServer, type HtmlHandler } from '@treenx/core/server/server';
import { createElement } from 'react';
import './types/index';
import { RouteIndex } from './route-index';
import { ssrHandler } from './handler';

before(() => {
  register(
    'test.integration.landing',
    'site',
    ({ value }: { value: NodeData & { heading?: string } }) =>
      createElement('section', { 'data-page': 'landing' },
        createElement('h1', null, value.heading ?? 'Untitled'),
      ),
  );
});

describe('SSR end-to-end', () => {
  it('serves a published landing page over HTTP', async () => {
    const tree = createMemoryTree();
    const landing: NodeData = {
      $path: '/sys/routes/about',
      $type: 'test.integration.landing',
      heading: 'About Us',
      site: { $type: 't.site', state: 'published', mode: 'static' },
      seo: { $type: 't.seo', title: 'About — Treenix' },
    } as NodeData;
    await tree.set(landing);

    const routes = new RouteIndex();
    routes.ingest(landing);

    const handler: HtmlHandler = async (_req, url) => {
      return ssrHandler(
        { pathname: url.pathname, query: url.searchParams, isAdmin: false },
        { routes, tree },
      );
    };

    const pipeline = createPipeline(createMemoryTree());
    const server = createHttpServer(pipeline, { htmlHandler: handler });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      // Published page → 200 + HTML with title and body.
      const res = await fetch(`http://127.0.0.1:${port}/about`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(html.startsWith('<!doctype html>'));
      assert.ok(html.includes('<title>About — Treenix</title>'));
      assert.ok(html.includes('data-page="landing"'));
      assert.ok(html.includes('About Us'));

      // Unknown URL → handler returns null → falls through (non-200, no static dir).
      const miss = await fetch(`http://127.0.0.1:${port}/missing`);
      assert.notEqual(miss.status, 200);
    } finally {
      server.close();
    }
  });

  it('preview gates draft content', async () => {
    const tree = createMemoryTree();
    const draft: NodeData = {
      $path: '/sys/routes/secret',
      $type: 'test.integration.landing',
      heading: 'Secret',
      site: { $type: 't.site', state: 'draft', mode: 'static' },
      seo: { $type: 't.seo', title: 'Secret' },
    } as NodeData;
    await tree.set(draft);

    const routes = new RouteIndex();
    routes.ingest(draft);

    const handler: HtmlHandler = async (_req, url) => ssrHandler(
      { pathname: url.pathname, query: url.searchParams, isAdmin: true },
      { routes, tree },
    );

    const pipeline = createPipeline(createMemoryTree());
    const server = createHttpServer(pipeline, { htmlHandler: handler });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      // Draft + admin + ?preview=1 → 200 + no-store.
      const res = await fetch(`http://127.0.0.1:${port}/secret?preview=1`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
      server.close();
    }
  });
});
