// Treenix HTTP Server — Layer 5
// createPipeline: pure tree composition (no HTTP).
// createHttpServer: HTTP + CORS + tRPC + static serving.

import { createLogger } from '#log';
import type { ExecTree, Tree } from '#tree';
import { withStoragePolicy } from '#tree/policy';
import { nodeHTTPRequestHandler } from '@trpc/server/adapters/node-http';
import { TRPCError } from '@trpc/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { withAcl } from '#security/acl-tree';
import { userIdFromAuthPath } from '#security/claims';
import { createMembershipProjector } from '#security/projector';
import {
  ANON_COOKIE_MAX_AGE,
  buildClearSessionCookie,
  buildSessionCookie,
  parseSessionCookie,
} from '#security/cookies';
import { resolveOrIssueSession } from '#security/sessions';
import { getComponentByName, resolve as resolveHandler } from '#core';
import { withMounts } from '#mount';
import { type CdcRegistry, type OnSelfWrite, withSubscriptions } from '#sub';
import type { TreeEvent } from '#tree';
import { runExternalWatch } from '#sub/external-watch';
import type { ExternalWatchStarter } from '#mount';
import { type DelegationHooks, withExecute } from './actions';
import { mutationLock, withCommitEnvelope } from './commit';
import { createTreeRouter, type TreeRouter, type TreeRouterOpts, type TrpcContext } from './trpc';
import { createWatchManager, type WatchManager } from '#sub/watch';

const log = createLogger('http');

export type RouteHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, tree: Tree) => Promise<void>;

// Dynamic route registry — services register/unregister routes at runtime
export const routeRegistry = new Map<string, RouteHandler>();

export type Pipeline = {
  /** Exec-capable (core-pxlu): withExecute-wrapped — tree.execute routes
   *  actions to the owning authority (local executor or federated mount). */
  tree: ExecTree;
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
export function createPipeline(bootstrap: Tree, opts?: TreeRouterOpts, wrapTree?: (t: Tree) => Tree, execHooks?: (tree: Tree) => DelegationHooks): Pipeline {
  // External-watch wiring contract (core-tcc1). Mounts (bottom layer) need
  // hooks that only exist once the upper layers are built: injectExternal
  // routes change-stream events through withSubscriptions so CDC (query/VP
  // invalidate) is computed and per-user routing applies — without it,
  // external writes bypass cdcEval and query mounts miss them. Filled ONCE at
  // the end of construction; mounts resolve lazily on first access, long
  // after this fn returns, so the single deferred assignment is safe.
  let wiring: {
    onSelfWrite: OnSelfWrite;
    injectExternal: (e: TreeEvent) => void;
    invalidatePath: (path: string) => void;
    invalidateAll: () => void;
  } | null = null;

  const startExternalWatch: ExternalWatchStarter = (tree, starterOpts) => {
    if (!wiring) {
      // Mount resolved during pipeline construction — shouldn't happen
      // (mounts are lazy) but fail loud if it does so the bug surfaces.
      throw new Error(`startExternalWatch[${starterOpts.source}]: pipeline not yet wired (mount resolved too early)`);
    }
    const ac = new AbortController();
    runExternalWatch(tree, {
      pathPrefix: starterOpts.pathPrefix,
      dedupWindowMs: starterOpts.dedupWindowMs,
      source: starterOpts.source,
      onSelfWrite: wiring.onSelfWrite,
      forwardEvent: wiring.injectExternal,
      invalidateCachePath: wiring.invalidatePath,
      invalidateCacheAll: wiring.invalidateAll,
      signal: ac.signal,
    });
    return () => ac.abort();
  };

  const mountable = withMounts(bootstrap, { startExternalWatch });
  // Storage policy (core-5fqq): migration → validation → $refs → cache → trash
  // as ONE step above the mounts, so fs/mongo/federation/query nodes all migrate
  // on read (R-gk8.29). Step order lives in tree/policy.ts — structural, not
  // composition-order in this factory.
  const policy = withStoragePolicy(mountable);
  // System identity on the migration-only base — used by factory bootstrap (seed,
  // anon-key, log writer) and request-edge session resolution. No validation, no
  // cache, no trash: boot writes anything, session revoke / GC hard-delete.
  const systemTree = withAcl(policy.base, 'system', ['system']);
  const watcher = createWatchManager();
  // gk8.12: sub/ stays ignorant of the auth layout and mount components —
  // the layer-owned detectors are injected here.
  const { tree: subscribed, cdc, onSelfWrite, injectExternalEvent } = withSubscriptions(policy.tree, (e) => watcher.notify(e), {
    claimsUserOf: userIdFromAuthPath,
    isConfigNode: (node) => !!node && getComponentByName(node, 'mount') !== undefined,
    componentHasAclRule: (type) => resolveHandler(type, 'acl') !== undefined,
    // F4 (core-anz4.3): query-watch membership judges each subscriber on
    // their OWN ACL projection — perms via the pre-ACL pipeline, claims via
    // the system tree (same sources the read path uses).
    projectMembership: createMembershipProjector(policy.tree, systemTree),
    // Listener fan-out must not inherit the commit envelope's lock ownership
    // (core-anz4.4) — a listener-spawned write queues like any writer.
    detachLocks: mutationLock.detach,
  });
  watcher.bindQueryRegistry(cdc);
  wiring = {
    onSelfWrite,
    injectExternal: injectExternalEvent,
    // Evict BOTH outer node cache AND mount-resolution cache. External
    // writes can rewrite a mount config node — cached adapter must drop.
    invalidatePath: (p) => { policy.invalidate(p); mountable.invalidateMount(p); },
    invalidateAll: () => { policy.invalidateAll(); mountable.invalidateMount('/'); },
  };
  // Audit (or any outer wrap) sits INSIDE the pipeline — above subscriptions but
  // BEFORE the router — so the tRPC router and every per-user withAcl wrap the
  // audited tree. Applying it later (in factory, after the router) left tRPC writes
  // un-audited (core-dpp). withAudit forwards scanChildren, so the audited tree is
  // still a valid read-runtime source for depth-1 getChildren. Absent wrapTree this
  // is a no-op — audit off = zero cost.
  const wrapped = wrapTree ? wrapTree(subscribed) : subscribed;

  // Tree.execute wiring (core-pxlu). delegate probes mounts for a foreign
  // authority; onDelegated is the v1 coherence answer to a delegated execute:
  // a remote action can mutate children/siblings under the mount, the node
  // cache has no prefix invalidation, and clients hold stale copies — so
  // GLOBAL reset (deliberate v1 bluntness; delegated executes are rare
  // federation-boundary events; mount-prefix precision comes with core-nin.7).
  // Mount adapters are NOT invalidated — remote data writes don't change
  // mount configs.
  const exec: TreeRouterOpts['exec'] = {
    delegate: (path) => mountable.resolveActionTree(path),
    onDelegated: () => {
      policy.invalidateAll();
      watcher.breakContinuity();
    },
    // Delegation audit hooks from the composition root (core-pa3m). A delegated
    // execute commits REMOTELY — the local write path never runs and the audit
    // wrap sees nothing; these journal the local user→action link instead. They
    // close over `subscribed` (below the wrap): delegation events are their own
    // journal rows, not re-audited mutations.
    ...execHooks?.(subscribed),
  };
  // Commit envelope between audit and execute (core-anz4.4): every mutation
  // verb reaching the pipeline — wire set/patch/remove, stream writes, foreign-
  // path ctx.tree.* writes, the full soft-remove span — serializes through the
  // shared mutationLock with executeAction spans and commit() batches, closing
  // the write→stored-reread windows in sub events and audit spans.
  const enveloped = withCommitEnvelope(wrapped);
  // withExecute OUTERMOST — local execute mutations flow through
  // subscriptions and audit. Identity-less: services get executeAction parity;
  // per-user identity binds in the wire session (per-request re-wrap).
  const tree = withExecute(enveloped, exec);
  // System-identity tree for request-time tRPC bootstrap ops (buildClaims,
  // register/login/logout/agentConnect/devLogin, createFilteredPush) — audited like
  // user writes since it wraps the same `tree`. Boot writes (seed/log/autostart) use
  // `systemTree` above (mountable, below the wrap), so audit never storms at startup.
  const systemTreeOps = withAcl(tree, 'system', ['system']);
  const router = createTreeRouter(tree, systemTreeOps, watcher, { ...opts, exec });

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
  /** When set: /health responds with the result; non-/health requests get 503 if unhealthy.
   *  May be async — the audit gate runs a throttled recovery probe inside (core-98jr). */
  healthCheck?: () => { healthy: boolean; reason: string } | Promise<{ healthy: boolean; reason: string }>;
};

/** HTTP server on top of an existing pipeline */
export function createHttpServer(pipeline: Pipeline, opts?: HttpServerOpts): Server {
  const { tree, systemTree, router } = pipeline;
  const allowedOrigins = opts?.allowedOrigins
    ?? (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',');
  const staticDir = opts?.staticDir
    ? resolve(opts.staticDir)
    : (process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : '');

  // Unhealthy-rejection log throttle — one line per interval, not per request.
  let lastRejectLogAt = 0;
  const REJECT_LOG_INTERVAL_MS = 30_000;

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
      const state = await opts.healthCheck();
      if (path === '/health') {
        res.writeHead(state.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }
      if (!state.healthy) {
        // The gate must never reject silently (core-98jr: an unhealthy server
        // 503'd every request for hours with nothing in the terminal).
        if (Date.now() - lastRejectLogAt > REJECT_LOG_INTERVAL_MS) {
          lastRejectLogAt = Date.now();
          console.error(`[health] rejecting requests with 503: ${state.reason}`);
        }
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
