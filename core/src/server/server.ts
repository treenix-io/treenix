// Treenix HTTP Server — Layer 5
// createPipeline: pure tree composition (no HTTP).
// createHttpServer: HTTP + CORS + tRPC + static serving.
// createTreenixServer: backward-compat (pipeline + HTTP in one call).

import { createLogger } from '#log';
import type { Tree } from '#tree';
import { withCache } from '#tree/cache';
import { nodeHTTPRequestHandler } from '@trpc/server/adapters/node-http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { resolveToken } from './auth';
import { withMounts } from './mount';
import { withRefIndex } from './refs';
import { type CdcRegistry, withSubscriptions } from './sub';
import { createTreeRouter, type TreeRouter, type TrpcContext } from './trpc';
import { withMigration } from './migrate';
import { withValidation } from './validate';
import { withVolatile } from './volatile';
import { createWatchManager, type WatchManager } from './watch';

const log = createLogger('http');

export type RouteHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, tree: Tree) => Promise<void>;

/** Generic HTML response — returned by an htmlHandler when it wants to take over a request. */
export type HtmlResponse = { status: number; headers: Record<string, string>; body: string };

/** Single fallback handler invoked after routeRegistry + tRPC, before static serving.
 *  Returning null falls through to the SPA static branch — same behavior as today
 *  for routes that don't opt into SSR. */
export type HtmlHandler = (req: import('node:http').IncomingMessage, url: URL) => Promise<HtmlResponse | null>;

// Dynamic route registry — services register/unregister routes at runtime
export const routeRegistry = new Map<string, RouteHandler>();

export type Pipeline = {
  tree: Tree;
  cdc: CdcRegistry;
  mountable: Tree;
  watcher: WatchManager;
  router: TreeRouter;
  createContext: (token: string | null) => Promise<TrpcContext>;
};

/** Pure tree composition — no HTTP, no side effects */
export function createPipeline(bootstrap: Tree): Pipeline {
  const migrated = withMigration(bootstrap);
  const mountable = withMounts(migrated);
  const volatile = withVolatile(mountable);
  const validated = withValidation(volatile);
  const refsIndexed = withRefIndex(validated);
  const cached = withCache(refsIndexed);
  let cdcRef: CdcRegistry;
  const watcher = createWatchManager({
    onUserRemoved: (userId) => cdcRef.unwatchAllQueries(userId),
  });
  const { tree, cdc } = withSubscriptions(cached, (e) => watcher.notify(e));
  cdcRef = cdc;
  const router = createTreeRouter(tree, watcher, undefined, cdc);

  const createContext = async (token: string | null): Promise<TrpcContext> => {
    const session = token ? await resolveToken(mountable, token) : null;
    return { session, token };
  };

  return { tree, cdc, mountable, watcher, router, createContext };
}

type HttpServerOpts = {
  allowedOrigins?: string[];
  staticDir?: string;
  /** Optional SSR fallback. Runs after routeRegistry + tRPC, before serveStatic.
   *  Returning null falls through to the existing static / SPA-fallback branch. */
  htmlHandler?: HtmlHandler;
};

/** HTTP server on top of an existing pipeline */
export function createHttpServer(pipeline: Pipeline, opts?: HttpServerOpts): Server {
  const { tree, mountable, router } = pipeline;
  const allowedOrigins = opts?.allowedOrigins
    ?? (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',');
  const staticDir = opts?.staticDir
    ? resolve(opts.staticDir)
    : (process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : '');

  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  };

  function serveStatic(pathname: string, res: import('node:http').ServerResponse): boolean {
    if (!staticDir) return false;

    const file = resolve(join(staticDir, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(staticDir)) return false; // path traversal blocked

    if (!existsSync(file) || !statSync(file).isFile()) {
      // SPA fallback: non-file paths → index.html
      const index = join(staticDir, 'index.html');
      if (!existsSync(index)) return false;
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      createReadStream(index).pipe(res);
      return true;
    }

    const ext = extname(file);
    const ct = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cache });
    createReadStream(file).pipe(res);
    return true;
  }

  type ConnParams = { info?: { connectionParams?: Record<string, string | undefined> | null } };

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Shared context factory — reads token from Authorization header or SSE connectionParams
    const createContext = async (opts?: ConnParams): Promise<TrpcContext> => {
      const auth = req.headers.authorization;
      const token =
        (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null) ??
        opts?.info?.connectionParams?.token ??
        null;
      const session = token ? await resolveToken(mountable, token) : null;
      return { session, token };
    };

    const pathname = (req.url ?? '/').split('?')[0];
    const handler = routeRegistry.get(pathname);
    if (handler) {
      return handler(req, res, tree);
    }

    // tRPC routes
    if (pathname.startsWith('/trpc')) {
      const path = pathname.replace(/^\/trpc/, '').replace(/^\//, '');
      await nodeHTTPRequestHandler({
        req, res, router, path, createContext,
        onError: ({ error, path: p }) => log.error(`trpc ${p}: ${error.message}`),
      });
      return;
    }

    // SSR fallback — opt-in handler for HTML responses
    if (opts?.htmlHandler) {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const html = await opts.htmlHandler(req, url);
        if (html) {
          res.writeHead(html.status, html.headers);
          res.end(html.body);
          return;
        }
      } catch (err) {
        const e = err as Error;
        log.error(`htmlHandler ${pathname}: ${e.message}\n${e.stack ?? ''}`);
        res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Internal Server Error');
        return;
      }
    }

    // Static files (frontend SPA)
    if (serveStatic(pathname, res)) return;

    // Fallback: try tRPC for legacy non-prefixed calls
    const path = pathname.replace(/^\//, '');
    await nodeHTTPRequestHandler({
      req, res, router, path, createContext,
      onError: ({ error, path: p }) => log.error(`trpc ${p}: ${error.message}`),
    });
  });
}

// Backward-compat wrapper — used by main.ts, e2e tests
export type TreenixServer = Pipeline & { server: Server };

export function createTreenixServer(bootstrap: Tree): TreenixServer {
  const pipeline = createPipeline(bootstrap);
  const server = createHttpServer(pipeline);
  return { ...pipeline, server };
}
