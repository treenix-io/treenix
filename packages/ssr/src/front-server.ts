// Treenix front-server — production HTTP server for the SPA + SSR.
//
// Standalone Node process, sibling to the data-API backend. Replaces Vite in
// production. Pipeline per request:
//   1. asset (extension or starts with /assets/) → serveStatic from CLIENT_DIR
//   2. HTML  → SSR via the prebuilt entry-server bundle, inject into index.html
//   3. miss  → SPA fallback (serve index.html as-is, client routes itself)
//
// Tree data comes from the backend over tRPC (read-only, anonymous).
// HTML cache: Map<url, {html, expires}> driven by t.site.cache.maxAge.
//
// Env:
//   PORT            front-server bind port (default 3210)
//   API_URL         backend tRPC base (default http://127.0.0.1:3211/trpc)
//   CLIENT_DIR      built SPA assets (default packages/react/dist-spa)
//   SSR_BUNDLE      prebuilt SSR entry-server (default packages/ssr/dist-ssr/entry-server.js)
//   ROUTE_TTL_MS    how long the in-memory RouteIndex is reused before refetch (default 30000)

import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NodeData } from '@treenx/core';
import type { Tree, ChildrenOpts, Page } from '@treenx/core/tree';
import { RouteIndex } from './route-index.ts';
import { ssrHandler, type RenderFn } from './handler.ts';
import { escape, escapeAttr, escapeUrl, escapeJson, extractBodyHeadHints } from './template.ts';

const port = Number(process.env.PORT ?? 3210);
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:3211/trpc';
const clientDir = resolve(process.env.CLIENT_DIR ?? 'engine/packages/react/dist-spa');
const ssrBundle = resolve(process.env.SSR_BUNDLE ?? 'engine/packages/ssr/dist-ssr/entry-server.js');
const routeTtlMs = Number(process.env.ROUTE_TTL_MS ?? 30_000);

const indexHtmlPath = join(clientDir, 'index.html');
if (!existsSync(indexHtmlPath)) {
  console.error(`[front] missing SPA build: ${indexHtmlPath} (run 'vite build')`);
  process.exit(1);
}
if (!existsSync(ssrBundle)) {
  console.error(`[front] missing SSR bundle: ${ssrBundle} (run 'vite build --ssr ...')`);
  process.exit(1);
}

const indexHtml = readFileSync(indexHtmlPath, 'utf-8');
const { render } = (await import(pathToFileURL(ssrBundle).href)) as { render: RenderFn };
const tree = createTrpcTree(apiUrl);
const routes = new RouteIndex();

let lastRouteRebuild = 0;
async function rebuildRoutes() {
  if (Date.now() - lastRouteRebuild < routeTtlMs) return;
  try {
    const page = await tree.getChildren('/sys/routes', { depth: -1 });
    routes.hydrate(page.items as NodeData[]);
    lastRouteRebuild = Date.now();
  } catch (err) {
    console.warn(`[front] route hydrate failed: ${(err as Error).message}`);
  }
}

// HTML cache — keyed by URL (excluding ?preview because that path bypasses cache).
type Cached = { html: string; status: number; headers: Record<string, string>; expires: number };
const htmlCache = new Map<string, Cached>();

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.map': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain',
};
const ASSET_EXT = /\.(js|mjs|css|map|svg|png|jpg|jpeg|gif|ico|webp|avif|woff|woff2|ttf|otf|json|wasm|txt|xml)(\?|$)/i;

function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  const file = resolve(join(clientDir, pathname));
  if (!file.startsWith(clientDir)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const ext = extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
  return true;
}

function isHtmlRequest(req: http.IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = req.url ?? '/';
  if (ASSET_EXT.test(url)) return false;
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html');
}

const ROOT_OPEN = /<div\s+id="root"[^>]*>/i;
const HEAD_OPEN = /<head[^>]*>/i;
const HEAD_CLOSE = /<\/head>/i;

function injectSsrIntoTemplate(
  template: string,
  result: { bodyContent: string; initialState: unknown; seo?: { title?: string; description?: string; canonical?: string; ogImage?: string } },
): string {
  const rendered = extractBodyHeadHints(result.bodyContent);
  let html = template.replace(ROOT_OPEN, m => `${m}${rendered.body}`);
  // <base> MUST come before any <link>/<script> with a relative URL — per HTML
  // spec it only affects URLs that follow it. Inject right after <head> open.
  html = html.replace(HEAD_OPEN, m => `${m}\n<base href="/" />`);
  const headBits: string[] = [];
  if (result.seo?.title) headBits.push(`<title>${escape(result.seo.title)}</title>`);
  if (result.seo?.description) headBits.push(`<meta name="description" content="${escapeAttr(result.seo.description)}" />`);
  if (result.seo?.canonical) headBits.push(`<link rel="canonical" href="${escapeUrl(result.seo.canonical)}" />`);
  if (result.seo?.ogImage) headBits.push(`<meta property="og:image" content="${escapeUrl(result.seo.ogImage)}" />`);
  headBits.push(...rendered.headHints);
  headBits.push(`<script type="application/json" id="treenix-initial">${escapeJson(result.initialState)}</script>`);
  return html.replace(HEAD_CLOSE, headBits.join('\n') + '\n</head>');
}

function maxAgeFromHeaders(headers: Record<string, string>): number {
  const cc = headers['Cache-Control'] ?? '';
  if (!cc || cc.includes('no-store')) return 0;
  const m = /max-age=(\d+)/.exec(cc);
  return m ? Number(m[1]) * 1000 : 0;
}

const apiOrigin = new URL(apiUrl);
const apiHost = apiOrigin.hostname;
const apiPort = Number(apiOrigin.port || (apiOrigin.protocol === 'https:' ? 443 : 80));

function proxyToApi(req: http.IncomingMessage, res: http.ServerResponse) {
  const proxyReq = http.request(
    {
      host: apiHost,
      port: apiPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${apiHost}:${apiPort}` },
    },
    (apiRes) => {
      res.writeHead(apiRes.statusCode ?? 502, apiRes.headers);
      apiRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    console.error(`[front] proxy ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('upstream error');
  });
  req.pipe(proxyReq);
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  // 0. tRPC + REST API — proxy straight to backend so the SPA's existing
  //    transport works through :3210 without an extra origin / CORS dance.
  if (url.startsWith('/trpc/') || url.startsWith('/api/')) {
    proxyToApi(req, res);
    return;
  }

  // 1. Static assets — always tried first; missing assets fall through to SSR/SPA.
  if (ASSET_EXT.test(url) || url.startsWith('/assets/')) {
    if (serveStatic(url.split('?')[0], res)) return;
  }

  // 2. SSR for HTML requests — serve cached if fresh.
  if (isHtmlRequest(req)) {
    const cached = htmlCache.get(url);
    if (cached && cached.expires > Date.now()) {
      res.writeHead(cached.status, cached.headers);
      res.end(cached.html);
      return;
    }

    try {
      debugger;
      console.log('JOPA')
      await rebuildRoutes();
      const parsed = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
      const ssr = await ssrHandler(
        { pathname: parsed.pathname, query: parsed.searchParams, isAdmin: false },
        { routes, tree, render },
      );
      if (ssr) {
        const html = injectSsrIntoTemplate(indexHtml, ssr);
        const ttlMs = maxAgeFromHeaders(ssr.headers);
        if (ttlMs > 0) {
          htmlCache.set(url, { html, status: ssr.status, headers: ssr.headers, expires: Date.now() + ttlMs });
        }
        res.writeHead(ssr.status, ssr.headers);
        res.end(html);
        return;
      }
    } catch (err) {
      console.error(`[front] ssr ${url}: ${(err as Error).stack ?? (err as Error).message}`);
    }

    // SPA fallback — serve plain index.html, client takes over.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(indexHtml);
    return;
  }

  // 3. Anything else (no Accept text/html) → 404.
  res.writeHead(404).end();
});

server.listen(port, () => {
  console.log(`[front] http://0.0.0.0:${port}  api=${apiUrl}  client=${clientDir}  ssr=${ssrBundle}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });

// ── tRPC-backed Tree adapter (read-only — same as vite-ssr's) ──

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
        path, limit: copts?.limit ?? 1000, offset: copts?.offset, depth: copts?.depth,
      });
      return items as Page<NodeData>;
    },
    async set() { throw new Error('ssr tree is read-only'); },
    async remove() { throw new Error('ssr tree is read-only'); },
    async patch() { throw new Error('ssr tree is read-only'); },
  };
}
