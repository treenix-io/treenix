// Treenity HTTP Server — Layer 5
// createPipeline: pure store composition (no HTTP).
// createHttpServer: HTTP + CORS + tRPC + static serving.
// createTreenityServer: backward-compat (pipeline + HTTP in one call).

import type { Tree } from '#tree';
import { withCache } from '#tree/cache';
import { nodeHTTPRequestHandler } from '@trpc/server/adapters/node-http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { resolveToken } from './auth';
import { withMounts } from './mount';
import type { ReactiveTree } from './sub';
import { unwatchAllQueries, withSubscriptions } from './sub';
import { createTreeRouter, type TreeRouter, type TrpcContext } from './trpc';
import { withValidation } from './validate';
import { withVolatile } from './volatile';
import { createWatchManager, type WatchManager } from './watch';

export type RouteHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, store: Tree) => Promise<void>;

// Dynamic route registry — services register/unregister routes at runtime
export const routeRegistry = new Map<string, RouteHandler>();

export type Pipeline = {
  store: ReactiveTree;
  mountable: Tree;
  watcher: WatchManager;
  router: TreeRouter;
  createContext: (token: string | null) => Promise<TrpcContext>;
};

/** Pure store composition — no HTTP, no side effects */
export function createPipeline(bootstrap: Tree): Pipeline {
  const mountable = withMounts(bootstrap);
  const volatile = withVolatile(mountable);
  const validated = withValidation(volatile);
  const cached = withCache(validated);
  const watcher = createWatchManager({
    onUserRemoved: (userId) => unwatchAllQueries(userId),
  });
  const store = withSubscriptions(cached, (e) => watcher.notify(e));
  const router = createTreeRouter(store, watcher);

  const createContext = async (token: string | null): Promise<TrpcContext> => {
    const session = token ? await resolveToken(mountable, token) : null;
    return { session, token };
  };

  return { store, mountable, watcher, router, createContext };
}

type HttpServerOpts = {
  allowedOrigins?: string[];
  staticDir?: string;
};

/** HTTP server on top of an existing pipeline */
export function createHttpServer(pipeline: Pipeline, opts?: HttpServerOpts): Server {
  const { store, mountable, router } = pipeline;
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
      return handler(req, res, store);
    }

    // tRPC routes
    if (pathname.startsWith('/trpc')) {
      const path = pathname.replace(/^\/trpc/, '').replace(/^\//, '');
      await nodeHTTPRequestHandler({ req, res, router, path, createContext });
      return;
    }

    // Static files (frontend SPA)
    if (serveStatic(pathname, res)) return;

    // Fallback: try tRPC for legacy non-prefixed calls
    const path = pathname.replace(/^\//, '');
    await nodeHTTPRequestHandler({ req, res, router, path, createContext });
  });
}

// Backward-compat wrapper — used by main.ts, e2e tests
export type TreenityServer = Pipeline & { server: Server };

export function createTreenityServer(bootstrap: Tree): TreenityServer {
  const pipeline = createPipeline(bootstrap);
  const server = createHttpServer(pipeline);
  return { ...pipeline, server };
}
