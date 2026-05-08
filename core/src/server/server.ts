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
import { extname, join, resolve, sep } from 'node:path';
import { TRPCError } from '@trpc/server';
import { resolveToken } from './auth';
import { withMounts } from './mount';
import { withRefIndex } from './refs';
import { createStreamTokenStore, type StreamTokenStore } from './stream-token';
import { type CdcRegistry, withSubscriptions } from './sub';
import { createTreeRouter, type TreeRouter, type TrpcContext } from './trpc';
import { withMigration } from './migrate';
import { withValidation } from './validate';
import { withVolatile } from './volatile';
import { createWatchManager, type WatchManager } from './watch';

const log = createLogger('http');

export type RouteHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, tree: Tree) => Promise<void>;

// Dynamic route registry — services register/unregister routes at runtime
export const routeRegistry = new Map<string, RouteHandler>();

export type Pipeline = {
  tree: Tree;
  cdc: CdcRegistry;
  mountable: Tree;
  watcher: WatchManager;
  router: TreeRouter;
  streamTokens: StreamTokenStore;
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
  const streamTokens = createStreamTokenStore();
  const router = createTreeRouter(tree, watcher, undefined, cdc, streamTokens);

  const createContext = async (token: string | null): Promise<TrpcContext> => {
    const session = token ? await resolveToken(mountable, token) : null;
    return { session, token, clientIp: null };
  };

  return { tree, cdc, mountable, watcher, router, streamTokens, createContext };
}

type HttpServerOpts = {
  allowedOrigins?: string[];
  staticDir?: string;
  /** When set: /health responds with the result; non-/health requests get 503 if unhealthy. */
  healthCheck?: () => { healthy: boolean; reason: string };
};

/** HTTP server on top of an existing pipeline */
export function createHttpServer(pipeline: Pipeline, opts?: HttpServerOpts): Server {
  const { tree, mountable, router, streamTokens } = pipeline;
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
    // Boundary-aware containment check — startsWith alone allows sibling escape ("/srv/static" ⊃ "/srv/static-evil").
    if (file !== staticDir && !file.startsWith(staticDir + sep)) return false;

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

  type ConnParams = { info?: { type?: string; connectionParams?: Record<string, string | undefined> | null } };

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

    // Health gate (audit append failure → server unhealthy → 503 on everything).
    // /health endpoint always responds with state for liveness probes.
    if (opts?.healthCheck) {
      const path = (req.url ?? '/').split('?')[0];
      const state = opts.healthCheck();
      if (path === '/health') {
        res.writeHead(state.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }
      if (!state.healthy) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unhealthy', reason: state.reason }));
        return;
      }
    }

    // R4-AUTH-3: take the RIGHTMOST X-Forwarded-For entry — the IP observed by the trusted
    // proxy itself. Leftmost is client-supplied (proxies append, never validate) and trivially
    // spoofed; using leftmost defeated F5's IP rate-limit. Single-hop trust assumption:
    // operators with deeper proxy topology should set clientIp at the edge proxy and forward
    // via a different header — TRUST_PROXY=true here means exactly one trusted hop.
    const trustProxy = process.env.TRUST_PROXY === 'true';
    const xff = trustProxy ? req.headers['x-forwarded-for'] : undefined;
    const xffStr = Array.isArray(xff) ? xff.join(',') : xff;
    const xffParts = xffStr ? xffStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const clientIp = xffParts[xffParts.length - 1] || req.socket.remoteAddress || null;

    // ALL subscriptions require a short-lived stream token. Discriminate by op type, NOT connectionParams presence —
    // a subscription request without connectionParams must NOT fall through to long-lived bearer auth.
    // Regular HTTP keeps long-lived bearer in Authorization header.
    const createContext = async (opts?: ConnParams): Promise<TrpcContext> => {
      if (opts?.info?.type === 'subscription') {
        const streamToken = opts.info.connectionParams?.token;
        const session = streamToken ? streamTokens.resolve(streamToken) : null;
        if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Stream token required for subscriptions' });
        return { session, token: null, clientIp };
      }
      const auth = req.headers.authorization;
      const token = (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null);
      const session = token ? await resolveToken(mountable, token) : null;
      return { session, token, clientIp };
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
        onError: ({ error, path: p }) => {
          // UNAUTHORIZED is the expected response when a logged-out client probes — don't spam error log.
          if (error.code === 'UNAUTHORIZED') log.warn(`trpc ${p}: ${error.message}`);
          else log.error(`trpc ${p}: ${error.message}`);
        },
      });
      return;
    }

    // Static files (frontend SPA)
    if (serveStatic(pathname, res)) return;

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

// Backward-compat wrapper — used by main.ts, e2e tests
export type TreenixServer = Pipeline & { server: Server };

export function createTreenixServer(bootstrap: Tree): TreenixServer {
  const pipeline = createPipeline(bootstrap);
  const server = createHttpServer(pipeline);
  return { ...pipeline, server };
}
