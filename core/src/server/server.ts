// Treenix HTTP Server — Layer 5
// createPipeline: pure tree composition (no HTTP).
// createHttpServer: HTTP + CORS + tRPC + static serving.

import { createLogger } from '#log';
import type { Tree } from '#tree';
import { type CachedTree, withCache } from '#tree/cache';
import { nodeHTTPRequestHandler } from '@trpc/server/adapters/node-http';
import { TRPCError } from '@trpc/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import {
  ANON_COOKIE_MAX_AGE,
  buildClearSessionCookie,
  buildSessionCookie,
  parseSessionCookie,
  resolveOrIssueSession,
  userIdFromAuthPath,
  withAcl,
} from '#security/auth';
import { getComponentByName } from '#core';
import { withMounts } from '#mount';
import { withRefIndex } from '#tree/refs';
import { type CdcRegistry, type OnSelfWrite, withSubscriptions } from '#sub';
import type { TreeEvent } from '#tree';
import { runExternalWatch } from '#sub/external-watch';
import type { ExternalWatchStarter, MountableTree } from '#mount';
import { createTreeRouter, type TreeRouter, type TreeRouterOpts, type TrpcContext } from './trpc';
import { withMigration } from '#tree/migration';
import { withTrash } from '#tree/trash';
import { withValidation } from '#tree/validation';
import { withVolatile } from '#tree/volatile';
import { createWatchManager, type WatchManager } from '#sub/watch';

const log = createLogger('http');

export type RouteHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, tree: Tree) => Promise<void>;

// Dynamic route registry — services register/unregister routes at runtime
export const routeRegistry = new Map<string, RouteHandler>();

export type Pipeline = {
  tree: Tree;
  cdc: CdcRegistry;
  mountable: Tree;
  /** Mountable wrapped with the 'system' identity. All bootstrap-layer reads/writes
   *  (seed, anon-key, log writer, session resolve) go through this — never raw mountable.
   *  System grant on root ({g:'system', p:R|W|A|S}) makes inherited ACL checks pass
   *  while keeping the auth pipeline visible to ACL handlers. */
  systemTree: Tree;
  watcher: WatchManager;
  router: TreeRouter;
  createContext: (token: string | null) => Promise<TrpcContext>;
};

/** Pure tree composition — no HTTP, no side effects */
export function createPipeline(bootstrap: Tree, opts?: TreeRouterOpts, wrapTree?: (t: Tree) => Tree): Pipeline {
  // Forward-declare onSelfWrite so mount adapters can wire external watches
  // before withSubscriptions exists. Mounts resolve lazily on first access,
  // long after this fn returns, so the late binding is safe.
  let onSelfWriteRef: OnSelfWrite | null = null;

  // Late-bound refs — see the comment on onSelfWriteRef. cachedRef gives
  // runExternalWatch a hook to invalidate the outer cache; injectExternalRef
  // routes external events through withSubscriptions so CDC (query/VP
  // invalidate) is computed and per-user routing applies. Without this,
  // external writes bypass cdcEval and query mounts miss them.
  let cachedRef: CachedTree | null = null;
  let injectExternalRef: ((e: TreeEvent) => void) | null = null;
  let mountableRef: MountableTree | null = null;

  const startExternalWatch: ExternalWatchStarter = (tree, starterOpts) => {
    const ac = new AbortController();
    if (!onSelfWriteRef || !cachedRef || !injectExternalRef || !mountableRef) {
      // Mount resolved during pipeline construction — shouldn't happen
      // (mounts are lazy) but fail loud if it does so the bug surfaces.
      throw new Error(`startExternalWatch[${starterOpts.source}]: pipeline not yet wired (mount resolved too early)`);
    }
    const cache = cachedRef;
    const inject = injectExternalRef;
    const mounts = mountableRef;
    runExternalWatch(tree, {
      pathPrefix: starterOpts.pathPrefix,
      dedupWindowMs: starterOpts.dedupWindowMs,
      source: starterOpts.source,
      onSelfWrite: onSelfWriteRef,
      forwardEvent: inject,
      // Evict BOTH outer node cache AND mount-resolution cache. External
      // writes can rewrite a mount config node — cached adapter must drop.
      invalidateCachePath: (p) => { cache.invalidate(p); mounts.invalidateMount(p); },
      invalidateCacheAll: () => { cache.invalidateAll(); mounts.invalidateMount('/'); },
      signal: ac.signal,
    });
    return () => ac.abort();
  };

  const mountable = withMounts(bootstrap, { startExternalWatch });
  mountableRef = mountable;
  // Migration sits ABOVE mounts so fs/mongo/federation/query nodes all migrate on
  // read (the wrapper used to sit below withMounts and persistent stores bypassed
  // it entirely — R-gk8.29). Below validation: validators must see current shapes.
  const migrated = withMigration(mountable);
  // System identity at the pre-validation layer — used by factory bootstrap (seed,
  // anon-key, log writer) and request-edge session resolution. Mirrors the current
  // raw-mountable layer; switching here adds the ACL gate without changing semantics.
  const systemTree = withAcl(migrated, 'system', ['system']);
  const volatile = withVolatile(migrated);
  const validated = withValidation(volatile);
  const refsIndexed = withRefIndex(validated);
  const cached = withCache(refsIndexed);
  cachedRef = cached;
  // Soft-delete (gk8.8): below subscriptions so the copy-writes stay silent,
  // above cache so copies land coherently; the remove event still emits above.
  // systemTree (below) keeps hard remove for session revoke / GC.
  const trashed = withTrash(cached);
  let cdcRef: CdcRegistry;
  const watcher = createWatchManager({
    onUserRemoved: (userId) => cdcRef.unwatchAllQueries(userId),
  });
  // gk8.12: sub/ stays ignorant of the auth layout and mount components —
  // the layer-owned detectors are injected here.
  const { tree: subscribed, cdc, onSelfWrite, injectExternalEvent } = withSubscriptions(trashed, (e) => watcher.notify(e), {
    claimsUserOf: userIdFromAuthPath,
    isConfigNode: (node) => !!node && getComponentByName(node, 'mount') !== undefined,
  });
  cdcRef = cdc;
  onSelfWriteRef = onSelfWrite;
  injectExternalRef = injectExternalEvent;
  // Audit (or any outer wrap) sits INSIDE the pipeline — above subscriptions but
  // BEFORE the router — so the tRPC router and every per-user withAcl wrap the
  // audited tree. Applying it later (in factory, after the router) left tRPC writes
  // un-audited (core-dpp). withAudit forwards scanChildren, so the audited tree is
  // still a valid read-runtime source for depth-1 getChildren. Absent wrapTree this
  // is a no-op — audit off = zero cost.
  const tree = wrapTree ? wrapTree(subscribed) : subscribed;
  // System-identity tree for request-time tRPC bootstrap ops (buildClaims,
  // register/login/logout/agentConnect/devLogin, createFilteredPush) — audited like
  // user writes since it wraps the same `tree`. Boot writes (seed/log/autostart) use
  // `systemTree` above (mountable, below the wrap), so audit never storms at startup.
  const systemTreeOps = withAcl(tree, 'system', ['system']);
  const router = createTreeRouter(tree, systemTreeOps, watcher, opts, cdc);

  const createContext = async (token: string | null): Promise<TrpcContext> => {
    // Programmatic API: treat input as bearer (no cookie). Invalid → throw loud.
    // Absent → issue anon (same model as HTTP path).
    const result = await resolveOrIssueSession(systemTree, null, token);
    if (result.kind !== 'ok') throw new Error(`createContext: ${result.kind}`);
    return { session: result.session, token: result.token, clientIp: null };
  };

  return { tree, cdc, mountable, systemTree, watcher, router, createContext };
}

type HttpServerOpts = {
  allowedOrigins?: string[];
  staticDir?: string;
  /** When set: /health responds with the result; non-/health requests get 503 if unhealthy. */
  healthCheck?: () => { healthy: boolean; reason: string };
};

/** HTTP server on top of an existing pipeline */
export function createHttpServer(pipeline: Pipeline, opts?: HttpServerOpts): Server {
  const { tree, systemTree, router } = pipeline;
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

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      // Required for browsers to send the session cookie on cross-origin requests.
      res.setHeader('Access-Control-Allow-Credentials', 'true');
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

    const pathname = (req.url ?? '/').split('?')[0];

    // routeRegistry: direct dispatch, NOT auth-wrapped. RouteHandler has no session
    // parameter (server.ts:27) — registered routes (MCP, etc.) do their own auth.
    // Treenix session auth applies ONLY to /trpc.
    const handler = routeRegistry.get(pathname);
    if (handler) {
      return handler(req, res, tree);
    }

    // tRPC routes — outer auth resolution; bad credentials → TRPCError so tRPC
    // emits a proper structured error envelope (SSE / query alike).
    if (pathname.startsWith('/trpc')) {
      // Auth: cookie (browsers, including SSE EventSource) OR Authorization Bearer header
      // (agents, MCP, tests). Cookies are HttpOnly + Secure + SameSite=Strict.
      const authHeader = req.headers.authorization;
      const bearer = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);
      const cookieToken = parseSessionCookie(req.headers.cookie);
      const authResult = await resolveOrIssueSession(systemTree, cookieToken, bearer);

      // Side effects on the response happen BEFORE tRPC handler runs:
      // - expired_session: clear the bad cookie so the browser drops it
      // - ok+issued: set the fresh anon cookie with year-long Max-Age
      if (authResult.kind === 'expired_session') {
        res.setHeader('Set-Cookie', buildClearSessionCookie());
      } else if (authResult.kind === 'ok' && authResult.issued) {
        res.setHeader('Set-Cookie', buildSessionCookie(authResult.token, ANON_COOKIE_MAX_AGE));
      }

      const createContext = async (): Promise<TrpcContext> => {
        if (authResult.kind === 'bad_bearer') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid bearer token' });
        }
        if (authResult.kind === 'expired_session') {
          // 🚨 NO silent downgrade to anon. Force re-auth at the client.
          // Owner regression rule: invalid/revoked user-session cookie MUST fail loud.
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'session expired' });
        }
        return {
          session: authResult.session,
          token: authResult.token,
          clientIp,
          setHeader: (name, value) => res.setHeader(name, value),
        };
      };

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

    // Static files (frontend SPA) — no auth, no 401 blocking the login page.
    if (serveStatic(pathname, res)) return;

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}
