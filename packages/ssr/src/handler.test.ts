import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '@treenx/core';
import type { NodeData } from '@treenx/core';
import type { Tree, Page } from '@treenx/core/tree';
import { createElement } from 'react';
import './types/index';
import { RouteIndex } from './route-index';
import { ssrHandler, type SsrRequest } from './handler';

const emptyTree: Tree = {
  async get() { return undefined; },
  async getChildren(): Promise<Page<NodeData>> { return { items: [], total: 0 }; },
  async set() {},
  async remove() { return false; },
  async patch() {},
};

before(() => {
  // Register a minimal site view for the test type.
  register(
    'test.handler.page',
    'site',
    ({ value }: { value: NodeData & { heading?: string } }) =>
      createElement('main', { 'data-page': value.heading }, value.heading ?? 'untitled'),
  );
});

function req(pathname: string, opts: { preview?: boolean; admin?: boolean } = {}): SsrRequest {
  const q = new URLSearchParams();
  if (opts.preview) q.set('preview', '1');
  return { pathname, query: q, isAdmin: !!opts.admin };
}

function indexWith(node: NodeData): RouteIndex {
  const ix = new RouteIndex();
  ix.ingest(node);
  return ix;
}

describe('ssrHandler', () => {
  it('returns null for unknown route (caller falls through to SPA)', async () => {
    const res = await ssrHandler(req('/missing'), { routes: new RouteIndex(), tree: emptyTree });
    assert.equal(res, null);
  });

  it('returns null when route node has no t.site (no SSR opt-in)', async () => {
    const node: NodeData = { $path: '/sys/routes/about', $type: 'page' } as NodeData;
    const res = await ssrHandler(req('/about'), { routes: indexWith(node), tree: emptyTree });
    assert.equal(res, null);
  });

  it('returns null when t.site.mode = spa', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'page',
      site: { $type: 't.site', state: 'published', mode: 'spa' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), { routes: indexWith(node), tree: emptyTree });
    assert.equal(res, null);
  });

  it('404s draft pages for the public', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'page',
      site: { $type: 't.site', state: 'draft', mode: 'static' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), { routes: indexWith(node), tree: emptyTree });
    assert.equal(res?.status, 404);
  });

  it('serves draft pages with no-store when admin + preview=1', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'test.handler.page',
      heading: 'About',
      site: { $type: 't.site', state: 'draft', mode: 'static' },
      seo: { $type: 't.seo', title: 'About — Draft' },
    } as NodeData;
    const res = await ssrHandler(
      req('/about', { preview: true, admin: true }),
      { routes: indexWith(node), tree: emptyTree },
    );
    assert.equal(res?.status, 200);
    assert.equal(res?.headers['Cache-Control'], 'no-store');
    assert.ok(res?.body.includes('content="noindex,nofollow"'));
    assert.ok(res?.body.includes('data-page="About"'));
  });

  it('serves a published static page with title + body', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'test.handler.page',
      heading: 'About',
      site: { $type: 't.site', state: 'published', mode: 'static' },
      seo: { $type: 't.seo', title: 'About Us' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), { routes: indexWith(node), tree: emptyTree });
    assert.equal(res?.status, 200);
    assert.ok(res?.body.startsWith('<!doctype html>'));
    assert.ok(res?.body.includes('<title>About Us</title>'));
    assert.ok(res?.body.includes('data-treenix-mode="static"'));
    // Static mode → no initial JSON.
    assert.ok(!res?.body.includes('treenix-initial'));
  });

  it('hydrate mode embeds initial state JSON + uses hydrate marker', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'test.handler.page',
      heading: 'Hi',
      site: { $type: 't.site', state: 'published', mode: 'hydrate' },
      seo: { $type: 't.seo', title: 'X' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), { routes: indexWith(node), tree: emptyTree });
    assert.equal(res?.status, 200);
    assert.ok(res?.body.includes('data-treenix-mode="hydrate"'));
    assert.ok(res?.body.includes('id="treenix-initial"'));
  });

  it('respects t.site.cache for non-preview requests', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'test.handler.page',
      heading: 'C',
      site: {
        $type: 't.site', state: 'published', mode: 'static',
        cache: { maxAge: 60, staleWhileRevalidate: 600 },
      },
      seo: { $type: 't.seo', title: 'C' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), { routes: indexWith(node), tree: emptyTree });
    assert.equal(res?.headers['Cache-Control'], 'public, max-age=60, stale-while-revalidate=600');
  });
});
