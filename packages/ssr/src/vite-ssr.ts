// Vite plugin: SSR via configureServer middleware. Plain `vite` keeps working —
// no separate dev-server process. Pipeline per HTML request:
//   1. Vite's own middlewares run first (assets, HMR, /@id, /@fs, /src, etc.)
//   2. Our middleware catches non-asset HTML requests, resolves URL against
//      /sys/routes (read from backend through a native session), renders SSR if matched route
//      has `t.site`, otherwise next().
//   3. Default Vite SPA index.html serves whatever falls through (appType: 'spa').
//
// Backend stays a pure data API.

import type { IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { openSsrSession } from '#native-session';
import { recoverSsrAuthentication } from '#auth-failure';
import { RouteIndex, fetchRouteNodes } from '#route-index';
import { ssrHandler, type RenderFn } from '#handler';
import { escape, escapeAttr, escapeUrl, escapeJson, extractBodyHeadHints } from '#template';

export type ViteSsrOpts = {
  /** Backend TWP origin. Default: http://127.0.0.1:${VITE_API_PORT|4882} */
  apiUrl?: string;
};

const ASSET_EXT =
  /\.(js|mjs|css|map|svg|png|jpg|jpeg|gif|ico|webp|avif|woff|woff2|ttf|otf|json|wasm|txt|xml)(\?|$)/i;

function isHtmlRequest(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = req.url ?? '/';
  if (url.startsWith('/@')) return false;
  if (url.startsWith('/node_modules/')) return false;
  if (url.startsWith('/src/')) return false;
  if (url.startsWith('/twp') || url.startsWith('/auth/') || url.startsWith('/api/')) return false;
  if (ASSET_EXT.test(url)) return false;
  // Only HTML requests reach rendering; protocol traffic uses the proxy.
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html');
}

export function viteSsrPlugin(opts: ViteSsrOpts = {}): Plugin {
  const apiUrl = opts.apiUrl ?? `http://127.0.0.1:${process.env.VITE_API_PORT ?? '4882'}`;

  return {
    name: 'treenix-ssr',
    enforce: 'pre',
    apply: 'serve',
    configureServer(vite: ViteDevServer) {
      // PRE-hook: register before Vite's internal SPA-fallback so we see original URLs.
      // Vite still handles assets/HMR/etc. via its own middlewares — we just delegate via next().
      vite.middlewares.use(async (req, res, next) => {
        if (!isHtmlRequest(req)) return next();
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.searchParams.get('ssr') === '0') return next();

        let session: Awaited<ReturnType<typeof openSsrSession>> | undefined;
        try {
          session = await openSsrSession(apiUrl, req, res);
          const routes = new RouteIndex();
          routes.hydrate(await fetchRouteNodes(session.reader));
          const mod = await vite.ssrLoadModule('@treenx/react/ssr/entry-server');
          const render = mod.render as RenderFn;

          const result = await ssrHandler(
            {
              pathname: url.pathname,
              query: url.searchParams,
              isAdmin: false,
              private: session.private,
            },
            { routes, reader: session.reader, render },
          );
          if (!result) return next();

          // Canonical Vite SSR pattern — use the SPA index.html as the
          // template so client `main.tsx` and asset URLs land in the right
          // places. Inject SSR'd markup into the existing #root, head meta,
          // and a <script id="treenix-initial"> for client hydration.
          const indexPath = resolve(vite.config.root, 'index.html');
          let template = await readFile(indexPath, 'utf-8');
          template = await vite.transformIndexHtml(req.url ?? '/', template);
          const html = injectSsrIntoTemplate(template, result);

          res.statusCode = result.status;
          for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
          res.end(html);
        } catch (err) {
          if (recoverSsrAuthentication(err, res)) {
            const template = await readFile(resolve(vite.config.root, 'index.html'), 'utf-8');
            res.end(await vite.transformIndexHtml(req.url ?? '/', template));
            return;
          }
          vite.ssrFixStacktrace(err as Error);
          next(err as Error);
        } finally {
          session?.close();
        }
      });
    },
  };
}

// ── SSR injection into SPA index.html template ──

const ROOT_OPEN = /<div\s+id="root"[^>]*>/i;
const HEAD_CLOSE = /<\/head>/i;

function injectSsrIntoTemplate(
  template: string,
  result: {
    bodyContent: string;
    initialState: unknown;
    seo?: { title?: string; description?: string; canonical?: string; ogImage?: string };
  },
): string {
  // 1. Body: replace `<div id="root">` opening so its content becomes our SSR markup.
  const rendered = extractBodyHeadHints(result.bodyContent);
  let html = template.replace(ROOT_OPEN, (m) => `${m}${rendered.body}`);

  // 2. Head meta — title overrides any in template; description/canonical/og added.
  // <base href="/"> forces all relative URLs in index.html (favicons, /src/app/main.tsx)
  // to resolve from origin root regardless of the SSR'd page's URL depth (/v/foo/bar).
  const headBits: string[] = ['<base href="/" />'];
  if (result.seo?.title) headBits.push(`<title>${escape(result.seo.title)}</title>`);
  if (result.seo?.description)
    headBits.push(`<meta name="description" content="${escapeAttr(result.seo.description)}" />`);
  if (result.seo?.canonical)
    headBits.push(`<link rel="canonical" href="${escapeUrl(result.seo.canonical)}" />`);
  if (result.seo?.ogImage)
    headBits.push(`<meta property="og:image" content="${escapeUrl(result.seo.ogImage)}" />`);
  headBits.push(...rendered.headHints);

  // 3. Initial state — pre-seeded into client TreeSource on hydration.
  headBits.push(
    `<script type="application/json" id="treenix-initial">${escapeJson(result.initialState)}</script>`,
  );

  if (headBits.length) {
    html = html.replace(HEAD_CLOSE, headBits.join('\n') + '\n</head>');
  }

  // Drop any duplicate <title> the SPA template had — keep ours (last wins in <head>).
  return html;
}
