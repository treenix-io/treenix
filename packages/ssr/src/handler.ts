// Request flow: resolve the route, render native reads to completion, then build the response.
// Draft pages require an authorized preview; hydration state contains the reads used during SSR.

import type { NodeData } from '@treenx/core';
import type { Reader } from '@treenx/core/kernel/types';
import type { NativeHydrationState } from '@treenx/react/tree/read-snapshot';
import { getComponent } from '@treenx/core';
import { Site } from './types/site';
import { Seo } from './types/seo';
import type { RouteIndex } from './route-index';
import { ServerTreeSource } from './server-tree-source';
import { buildHtmlShell } from './template';
import { SsrDataUnresolved } from './errors';
// Type-only import — keeps the entry-server module out of the import graph
// at config-bundle time (it pulls virtual: barrels that Vite's config loader
// can't resolve). Caller MUST pass deps.render with a freshly loaded copy.
import type { RenderArgs } from '@treenx/react/ssr/entry-server';

/** Render function signature — Vite middleware passes a hot-loaded copy via deps.render. */
export type RenderFn = (args: RenderArgs) => string;

export type SsrResponse = {
  status: number;
  headers: Record<string, string>;
  /** Full standalone HTML doc (legacy / static-only fallback). */
  body: string;
  /** Inner body content — the SSR markup that should land inside `<div id="root">`.
   *  Vite-side hosts inject this into the SPA index.html so client `main.tsx`
   *  can `hydrateRoot()` over the existing markup. */
  bodyContent: string;
  /** Native reads to seed client hydration so the first paint reuses SSR data. */
  initialState: NativeHydrationState;
  /** SEO metadata extracted from the route node — caller injects into <head>. */
  seo?: { title?: string; description?: string; canonical?: string; ogImage?: string };
};

export type SsrRequest = {
  /** URL pathname (no query). */
  pathname: string;
  /** Decoded query — only `?preview=1` is consulted today. */
  query: URLSearchParams;
  /** True iff caller has admin claim (preview gate). */
  isAdmin: boolean;
  private?: boolean;
};

export type SsrHandlerDeps = {
  routes: RouteIndex;
  /** ACL-scoped reader for this request. */
  reader: Reader;
  /** Tailwind JIT — given the rendered HTML, returns the page's CSS. Phase 5 wires the real one. */
  tailwindJit?: (html: string) => Promise<string> | string;
  /** Render-loop budget. */
  maxPasses?: number;
  /** React render fn. Vite middleware passes a fresh ssrLoadModule copy so view
   *  edits HMR-reload. Required — entry-server is loaded by the caller (not
   *  here) so the SSR module graph stays out of Vite's config bundle. */
  render: RenderFn;
};

const DEFAULT_PASSES = 5;

export async function ssrHandler(
  req: SsrRequest,
  deps: SsrHandlerDeps,
): Promise<SsrResponse | null> {
  const match = deps.routes.resolve(req.pathname);
  if (!match) return null;

  const routeNode = match.node;
  const site = getComponent(routeNode, Site);
  if (!site) return null;
  if (site.mode === 'spa') return null;

  const isPreview = req.query.get('preview') === '1' && req.isAdmin;
  if (site.state === 'draft' && !isPreview) {
    return {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '',
      bodyContent: '',
      initialState: { reads: [] },
    };
  }

  const source = new ServerTreeSource(deps.reader);
  // Make the route's target node available immediately — most renders read it.
  const targetNode = routeNode;

  const maxPasses = deps.maxPasses ?? DEFAULT_PASSES;
  const render = deps.render;
  const queryStr = req.query.toString();
  const search = queryStr ? `?${queryStr}` : '';
  let html = '';
  for (let pass = 0; pass < maxPasses; pass++) {
    html = render({
      source,
      node: targetNode,
      rest: match.rest,
      mode: site.mode === 'hydrate' ? 'hydrate' : 'static',
      pathname: req.pathname,
      search,
    });
    if (source.pendingCount() === 0) break;
    await source.flushPending();
  }
  if (source.pendingCount() > 0) {
    const { paths, children } = source.pending();
    throw new SsrDataUnresolved([...paths, ...children.map((c) => `children:${c}`)]);
  }

  const css = deps.tailwindJit ? await deps.tailwindJit(html) : '';
  const seoNode = getComponent(routeNode, Seo);
  const initialState = source.serialize();

  // Standalone fallback (used when caller has no SPA template to inject into).
  const body = buildHtmlShell({
    html,
    css,
    seo: seoNode ?? undefined,
    mode: site.mode,
    initialState: site.mode === 'hydrate' ? initialState : undefined,
    tailwindRuntime: !!site.tailwindRuntime,
    isPreview,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
  };
  if (isPreview || req.private) {
    headers['Cache-Control'] = req.private ? 'private, no-store' : 'no-store';
  } else if (site.cache?.maxAge != null) {
    const swr = site.cache.staleWhileRevalidate;
    headers['Cache-Control'] =
      `public, max-age=${site.cache.maxAge}` +
      (swr != null ? `, stale-while-revalidate=${swr}` : '');
  }

  const seo = seoNode
    ? {
        title: seoNode.title,
        description: seoNode.description,
        canonical: seoNode.canonical,
        ogImage: seoNode.image,
      }
    : undefined;

  return { status: 200, headers, body, bodyContent: html, initialState, seo };
}
