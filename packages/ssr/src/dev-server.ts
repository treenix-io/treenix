// Dev server — canonical Vite SSR cookbook layout.
//
// We own the http listener; Vite is mounted as a middleware (middlewareMode +
// appType: 'custom'). The pipeline per request:
//   1. Vite middlewares run first — assets, HMR client, /@id, /@fs, /src, etc.
//   2. Our SSR middleware catches non-asset HTML requests, resolves the URL
//      against /sys/routes (read from backend over tRPC), and returns a fully
//      rendered HTML body when the matched route opts into SSR (`t.site`).
//   3. SPA fallback for everything else — serves the same index.html the SPA
//      build uses, transformed by vite.transformIndexHtml so HMR client +
//      asset rewrites are applied.
//
// Run: `tsx engine/packages/ssr/src/dev-server.ts`. Env: PORT (default 3210),
// VITE_API_PORT (backend tRPC port, default 3211), VITE_CONFIG_FILE.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import type { ViteDevServer } from 'vite';
import type { NodeData } from '@treenx/core';
import type { Tree, ChildrenOpts, Page } from '@treenx/core/tree';
import { RouteIndex } from './route-index';
import { ssrHandler, type RenderFn } from './handler';

const port = Number(process.env.PORT ?? 3210);
const apiPort = process.env.VITE_API_PORT ?? '3211';
const trpcUrl = `http://127.0.0.1:${apiPort}/trpc`;

// Locate the @treenx/react package — that's where vite.config.ts + index.html live.
const here = dirname(fileURLToPath(import.meta.url));
const reactPkgRoot = resolve(here, '../../react');
const indexHtmlPath = resolve(reactPkgRoot, 'index.html');

const vite: ViteDevServer = await createViteServer({
  root: reactPkgRoot,
  configFile: process.env.VITE_CONFIG_FILE
    ? resolve(process.env.VITE_CONFIG_FILE)
    : resolve(reactPkgRoot, 'vite.config.ts'),
  server: { middlewareMode: true, host: '0.0.0.0', port },
  appType: 'custom',
});

const tree = createTrpcTree(trpcUrl);
const routes = new RouteIndex();

async function rebuildRoutes() {
  try {
    const page = await tree.getChildren('/sys/routes', { depth: -1 });
    routes.hydrate(page.items as NodeData[]);
  } catch (err) {
    vite.config.logger.warn(`[ssr] route hydrate failed: ${(err as Error).message}`);
  }
}

await rebuildRoutes();
console.log(`[ssr-dev] indexed ${routes.size()} route(s)`);

// SSR middleware — runs AFTER vite.middlewares.
vite.middlewares.use(async (req, res, next) => {
  if (!isHtmlRequest(req)) return next();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.searchParams.get('ssr') === '0') return next();

  try {
    await rebuildRoutes();

    const mod = await vite.ssrLoadModule('@treenx/react/ssr/entry-server');
    const render = mod.render as RenderFn;

    const result = await ssrHandler(
      { pathname: url.pathname, query: url.searchParams, isAdmin: false },
      { routes, tree, render },
    );
    if (!result) return next();

    const html = await vite.transformIndexHtml(req.url ?? '/', result.body);
    res.statusCode = result.status;
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    res.end(html);
  } catch (err) {
    vite.ssrFixStacktrace(err as Error);
    next(err as Error);
  }
});

// SPA fallback — index.html for HTML requests Vite + SSR didn't serve.
vite.middlewares.use(async (req, res, next) => {
  if (!isHtmlRequest(req)) return next();
  try {
    let html = await readFile(indexHtmlPath, 'utf-8');
    html = await vite.transformIndexHtml(req.url ?? '/', html);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(html);
  } catch (err) {
    vite.ssrFixStacktrace(err as Error);
    next(err as Error);
  }
});

const server = http.createServer(vite.middlewares);
server.listen(port, '0.0.0.0', () => {
  console.log(`[ssr-dev] listening on http://0.0.0.0:${port}  (api → ${trpcUrl})`);
});

process.on('SIGTERM', async () => {
  await vite.close();
  server.close();
  process.exit(0);
});

// ── helpers ──

const ASSET_EXT = /\.(js|mjs|css|map|svg|png|jpg|jpeg|gif|ico|webp|avif|woff|woff2|ttf|otf|json|wasm|txt|xml)(\?|$)/i;

function isHtmlRequest(req: http.IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = req.url ?? '/';
  if (url.startsWith('/@')) return false;
  if (url.startsWith('/node_modules/')) return false;
  if (url.startsWith('/src/')) return false;
  if (ASSET_EXT.test(url)) return false;
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html') || accept === '' || accept.includes('*/*');
}

function createTrpcTree(url: string): Tree {
  let client: any;
  async function getClient() {
    if (!client) {
      const { createClient } = await import('@treenx/core/server/client');
      client = createClient(url);
    }
    return client;
  }
  return {
    async get(path: string) {
      const c = await getClient();
      return c.get.query({ path }) as Promise<NodeData | undefined>;
    },
    async getChildren(path: string, copts?: ChildrenOpts): Promise<Page<NodeData>> {
      const c = await getClient();
      const items = await c.getChildren.query({
        path,
        limit: copts?.limit ?? 1000,
        offset: copts?.offset,
        depth: copts?.depth,
      });
      return items as Page<NodeData>;
    },
    async set() { throw new Error('ssr tree is read-only'); },
    async remove() { throw new Error('ssr tree is read-only'); },
    async patch() { throw new Error('ssr tree is read-only'); },
  };
}
