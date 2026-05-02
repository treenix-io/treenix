// ssrHandler — orchestrates URL → tree-resolved node → SSR HTML response.
//
// Flow per request:
//   1. RouteIndex.resolve(url) → route node (or null → null response, falls through to SPA).
//   2. Read t.site off route node.
//        - missing → null (no SSR for this route).
//        - mode='spa' → null.
//        - state='draft' && !preview → 404.
//        - state='draft' && preview → render with no-store + force noindex.
//   3. Wrap caller's tree in ServerTreeSource.
//   4. Render loop: render() → if pendingCount → flushPending() → re-render. Bounded.
//   5. Read t.seo (route node first, then target node), build HTML shell.
//   6. Return { status, headers, body }.

import type { NodeData } from '@treenx/core';
import type { Tree } from '@treenx/core/tree';
import { getComponent } from '@treenx/core';
import { Site } from './types/site';
import { Seo } from './types/seo';
import type { RouteIndex } from './route-index';
import { ServerTreeSource } from './server-tree-source';
import { buildHtmlShell } from './template';
import { SsrDataUnresolved } from './errors';
import { render as defaultRender, type RenderArgs } from '@treenx/react/ssr/entry-server';

/** Render function signature — Vite middleware passes a hot-loaded copy via deps.render. */
export type RenderFn = (args: RenderArgs) => string;

export type SsrResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type SsrRequest = {
  /** URL pathname (no query). */
  pathname: string;
  /** Decoded query — only `?preview=1` is consulted today. */
  query: URLSearchParams;
  /** True iff caller has admin claim (preview gate). */
  isAdmin: boolean;
};

export type SsrHandlerDeps = {
  routes: RouteIndex;
  /** ACL-scoped Tree wrapping the request's user. */
  tree: Tree;
  /** Tailwind JIT — given the rendered HTML, returns the page's CSS. Phase 5 wires the real one. */
  tailwindJit?: (html: string) => Promise<string> | string;
  /** Render-loop budget. */
  maxPasses?: number;
  /** Override the React render fn — Vite middleware passes a fresh ssrLoadModule copy
   *  so view edits HMR-reload. Defaults to the statically-imported render. */
  render?: RenderFn;
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
    return { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '' };
  }

  const source = new ServerTreeSource(deps.tree);
  // Make the route's target node available immediately — most renders read it.
  const targetNode: NodeData = routeNode;

  const maxPasses = deps.maxPasses ?? DEFAULT_PASSES;
  const render = deps.render ?? defaultRender;
  let html = '';
  for (let pass = 0; pass < maxPasses; pass++) {
    html = render({
      source,
      node: targetNode,
      rest: match.rest,
      mode: site.mode === 'hydrate' ? 'hydrate' : 'static',
      pathname: req.pathname,
    });
    if (source.pendingCount() === 0) break;
    await source.flushPending();
  }
  if (source.pendingCount() > 0) {
    const { paths, children } = source.pending();
    throw new SsrDataUnresolved([...paths, ...children.map(c => `children:${c}`)]);
  }

  const css = deps.tailwindJit ? await deps.tailwindJit(html) : '';
  const seo = getComponent(routeNode, Seo) ?? undefined;

  const body = buildHtmlShell({
    html,
    css,
    seo,
    mode: site.mode,
    initialState: site.mode === 'hydrate' ? source.serialize() : undefined,
    tailwindRuntime: !!site.tailwindRuntime,
    isPreview,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
  };
  if (isPreview) {
    headers['Cache-Control'] = 'no-store';
  } else if (site.cache?.maxAge != null) {
    const swr = site.cache.staleWhileRevalidate;
    headers['Cache-Control'] = `public, max-age=${site.cache.maxAge}` +
      (swr != null ? `, stale-while-revalidate=${swr}` : '');
  }

  return { status: 200, headers, body };
}
