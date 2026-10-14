import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeData } from '@treenx/core';
import type { Reader } from '@treenx/core/kernel/types';
import { createElement } from 'react';
import './types/index';
import { RouteIndex } from './route-index';
import { renderToStaticMarkup } from 'react-dom/server';
import { ssrHandler, type SsrRequest, type RenderFn } from './handler';

// Tests inject this minimal render — entry-server itself can't be imported
// here because it does `import 'virtual:mod-site-views'` (Vite-only).
const testRender: RenderFn = ({ node }) => {
  const heading = typeof node.heading === 'string' ? node.heading : 'untitled';
  return renderToStaticMarkup(createElement('main', { 'data-page': heading }, heading));
};

const deps = (routes: RouteIndex, reader: Reader) => ({ routes, reader, render: testRender });

const emptyTree: Reader = { async read() { return { list: [], copies: [], at: [] }; } };

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
    const res = await ssrHandler(req('/missing'), deps(new RouteIndex(), emptyTree));
    assert.equal(res, null);
  });

  it('returns null when route node has no t.site (no SSR opt-in)', async () => {
    const node: NodeData = { $path: '/sys/routes/about', $type: 'page' } as NodeData;
    const res = await ssrHandler(req('/about'), deps(indexWith(node), emptyTree));
    assert.equal(res, null);
  });

  it('returns null when t.site.mode = spa', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'page',
      '#site': { $type: 't.site', state: 'published', mode: 'spa' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), deps(indexWith(node), emptyTree));
    assert.equal(res, null);
  });

  it('404s draft pages for the public', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'page',
      '#site': { $type: 't.site', state: 'draft', mode: 'static' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), deps(indexWith(node), emptyTree));
    assert.equal(res?.status, 404);
  });

  it('serves draft pages with no-store when admin + preview=1', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'test.handler.page',
      heading: 'About',
      '#site': { $type: 't.site', state: 'draft', mode: 'static' },
      '#seo': { $type: 't.seo', title: 'About — Draft' },
    } as NodeData;
    const res = await ssrHandler(
      req('/about', { preview: true, admin: true }),
      deps(indexWith(node), emptyTree),
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
      '#site': { $type: 't.site', state: 'published', mode: 'static' },
      '#seo': { $type: 't.seo', title: 'About Us' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), deps(indexWith(node), emptyTree));
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
      '#site': { $type: 't.site', state: 'published', mode: 'hydrate' },
      '#seo': { $type: 't.seo', title: 'X' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), deps(indexWith(node), emptyTree));
    assert.equal(res?.status, 200);
    assert.ok(res?.body.includes('data-treenix-mode="hydrate"'));
    assert.ok(res?.body.includes('id="treenix-initial"'));
  });

  it('respects t.site.cache for non-preview requests', async () => {
    const node = {
      $path: '/sys/routes/about', $type: 'test.handler.page',
      heading: 'C',
      '#site': {
        $type: 't.site', state: 'published', mode: 'static',
        cache: { maxAge: 60, staleWhileRevalidate: 600 },
      },
      '#seo': { $type: 't.seo', title: 'C' },
    } as NodeData;
    const res = await ssrHandler(req('/about'), deps(indexWith(node), emptyTree));
    assert.equal(res?.headers['Cache-Control'], 'public, max-age=60, stale-while-revalidate=600');
  });
});
