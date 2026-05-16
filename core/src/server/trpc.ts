// Treenix tRPC Router — Layer 4
// Thin transport wrapper over shared ops (actions.ts).
// Responsibilities: input validation (Zod), error mapping (OpError → TRPCError), watch wiring.

import { isRef, type NodeData, R, S } from '#core';
import { assertSafePath } from '#core/path';
import { createTreeP } from '#protocol/treep';
import type { Tree } from '#tree';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
// Pin @trpc/server internal types to a public subpath so declaration emit stays portable (TS2742).
import type {} from '@trpc/server/unstable-core-do-not-import';
import { z } from 'zod';
import {
  applyTemplate as applyTemplateOp,
  executeAction,
  executeStream,
  setComponent as setComponentOp,
} from './actions';
import { buildClaims, buildClearSessionCookie, buildSessionCookie, type Session, withAcl } from './auth';
import { agentConnect, agentInitPair, devLogin, loginUser, logoutUser, registerUser } from './auth-ops';
import { OpError } from '#errors';
import { checkRate } from './rate-limit';
import { deployPrefab as deployPrefabOp } from './prefab';
import { type CdcRegistry, type NodeEvent } from './sub';
import { extractPaths } from './volatile';
import { type WatchManager } from './watch';
import { createFilteredPush } from './watch-filter';

export type TrpcContext = {
  session: Session | null;
  token: string | null;
  clientIp: string | null;
  /** Set a response header — used by login/register/logout to set the session cookie. */
  setHeader?: (name: string, value: string) => void;
};

/** Zod schema that validates tree paths — rejects traversal, null bytes, double slashes */
const safePath = z.string().superRefine((p, ctx) => {
  try { assertSafePath(p); }
  catch (e) {
    console.error(`[trpc] bad path rejected: ${JSON.stringify(p)}`);
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
  }
});

/** Zod schema matching PatchOp — test, replace, add, delete */
const patchOps = z.array(z.union([
  z.tuple([z.literal('t'), z.string(), z.unknown()]).readonly(),
  z.tuple([z.literal('r'), z.string(), z.unknown()]).readonly(),
  z.tuple([z.literal('a'), z.string(), z.unknown()]).readonly(),
  z.tuple([z.literal('d'), z.string()]).readonly(),
]));

/** Higher-level dispatcher: tree + session + action input → result.
 *  Mods (e.g. harness/audit) inject this to add capability narrowing or other
 *  pre-execute logic. Without an executor, sessions go through plain executeAction. */
export type SessionExecutor = (
  tree: Tree,
  session: Session,
  input: { path: string; type?: string; key?: string; action: string; data?: unknown },
) => Promise<unknown>;

export type TreeRouterOpts = {
  /** TTL for cached claims in SSE connections (ms). Default 30s. 0 = no cache. */
  claimsTtlMs?: number;
  /** Optional dispatcher for workload-bound sessions (those with `session.scopeRef`).
   *  When undefined, all sessions go through plain executeAction — zero overhead. */
  executor?: SessionExecutor;
};

const DEFAULT_CLAIMS_TTL_MS = 30_000;
export const SSE_PING_INTERVAL_MS = 15_000;
export const SSE_RECONNECT_AFTER_INACTIVITY_MS = 60_000;

export function createTreeRouter(baseStore: Tree, watcher: WatchManager, opts?: TreeRouterOpts, cdc?: CdcRegistry) {
  const claimsTtlMs = opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;
  const t = initTRPC.context<TrpcContext>().create({
    sse: {
      ping: { enabled: true, intervalMs: SSE_PING_INTERVAL_MS },
      client: { reconnectAfterInactivityMs: SSE_RECONNECT_AFTER_INACTIVITY_MS },
    },
  });

  // Map domain errors → TRPCError. Base middleware for all procedures.
  function mapErrors(result: { ok: boolean; error?: { cause?: unknown } }) {
    if (result.ok) return;
    const cause = result.error?.cause;
    if (cause instanceof OpError) {
      // Domain code → TRPCError code. Codes not in tRPC's enum map to FORBIDDEN.
      const code = cause.code === 'KIND_VIOLATION' ? 'FORBIDDEN' : cause.code;
      throw new TRPCError({ code, message: cause.message });
    }
  }

  const base = t.procedure.use(async ({ next }) => {
    const result = await next();
    mapErrors(result);
    return result;
  });

  const authed = base.use(async ({ ctx, next }) => {
    const userId = ctx.session?.userId ?? null;
    const claims = ctx.session?.claims ?? (userId ? await buildClaims(baseStore, userId) : ['public']);
    const tree = withAcl(baseStore, userId, claims);
    // Workload sessions (scopeRef set) require a configured executor; otherwise
    // fail-closed — silent fallback would let a workload escape narrowing.
    const session = ctx.session;
    const isWorkload = !!session?.scopeRef;
    if (isWorkload && !opts?.executor) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR',
        message: 'workload session present but no executor configured' });
    }
    const dispatch = isWorkload
      ? (path: string, key: string | undefined, action: string, data?: unknown) =>
          opts!.executor!(tree, session!, { path, type: undefined, key, action, data })
      : (path: string, key: string | undefined, action: string, data?: unknown) =>
          executeAction(tree, path, undefined, key, action, data, { userId, claims });
    const tp = createTreeP(tree, dispatch);
    return next({ ctx: { ...ctx, tree, tp, claims } });
  });

  return t.router({
    get: authed
      .input(z.object({ path: safePath, watch: z.boolean().optional() }))
      .query(async ({ input, ctx }) => {
        const node = await ctx.tree.get(input.path);
        if (input.watch && node && ctx.session && (await ctx.tree.getPerm(input.path)) & S)
          watcher.watch(ctx.session.userId, [input.path]);
        return node;
      }),

    // Fetch node + resolve $ref targets. Returns [requested, ...resolved].
    resolve: authed
      .input(z.object({ path: safePath, watch: z.boolean().optional() }))
      .query(async ({ input, ctx }) => {
        const node = await ctx.tree.get(input.path);
        if (!node) return [];
        const result: NodeData[] = [node];

        if (input.watch && ctx.session && (await ctx.tree.getPerm(input.path)) & S)
          watcher.watch(ctx.session.userId, [input.path]);

        if (isRef(node)) {
          const target = await ctx.tree.get(node.$ref as string);
          if (target) {
            result.push(target);
            if (input.watch && ctx.session && (await ctx.tree.getPerm(target.$path)) & S)
              watcher.watch(ctx.session.userId, [target.$path]);
          }
        }

        return result;
      }),

    getChildren: authed
      .input(
        z.object({
          path: safePath,
          limit: z.number().optional().default(100),
          offset: z.number().optional(),
          depth: z.number().optional(),
          watch: z.boolean().optional(),
          watchNew: z.boolean().optional(),
        }),
      )
      .query(async ({ input, ctx }) => {
        const result = await ctx.tree.getChildren(input.path, {
          limit: input.limit,
          offset: input.offset,
          depth: input.depth,
        }, ctx);

        if (ctx.session) {
          if (input.watch) {
            const watchable: string[] = [];
            for (const n of result.items)
              if ((await ctx.tree.getPerm(n.$path)) & S) watchable.push(n.$path);
            if (watchable.length) watcher.watch(ctx.session.userId, watchable);
          }
          if (input.watchNew) {
            if (result.queryMount) {
              const q = result.queryMount;
              cdc?.watchQuery(input.path, q.source, q.match, ctx.session.userId);
            }
            watcher.watch(ctx.session.userId, [input.path], { children: true, autoWatch: input.watch });
          }
        }
        return result;
      }),

    set: authed
      .input(z.object({ node: z.record(z.string(), z.unknown()).refine(n => typeof n.$path === 'string', '$path required') }))
      .mutation(({ input, ctx }) => {
        assertSafePath(input.node.$path as string);
        const { $patches, ...clean } = input.node;
        return ctx.tp.set(clean.$path as string, clean);
      }),

    patch: authed
      .input(z.object({ path: safePath, ops: patchOps }))
      .mutation(({ input, ctx }) => ctx.tp.set(input.path, input.ops)),

    setComponent: authed
      .input(
        z.object({ path: safePath, name: z.string(), data: z.record(z.string(), z.unknown()), rev: z.number().optional() }),
      )
      .mutation(({ input, ctx }) => setComponentOp(ctx.tree, input.path, input.name, input.data, input.rev)),

    remove: authed
      .input(z.object({ path: safePath }))
      .mutation(({ input, ctx }) => ctx.tp.remove(input.path)),

    execute: authed
      .input(
        z.object({
          path: safePath,
          type: z.string().optional(),   // $type for component verification
          key: z.string().optional(),    // field key for component selection
          action: z.string(),
          data: z.unknown().optional(),
          watch: z.boolean().optional(), // subscribe to paths returned in result
        }),
      )
      .mutation(async ({ input, ctx }) => {
        // Build action URI: /path#[key.]action()
        const frag = input.key ? `${input.key}.${input.action}` : input.action;
        const result = await ctx.tp.set(`${input.path}#${frag}()`, input.data);
        if (input.watch && ctx.session) {
          // R4-MOUNT-5: action result is handler-controlled (incl. dynamic actions running in
          // QuickJS). Paths fed into watcher.watch must be (a) shape-validated (assertSafePath),
          // (b) cap-limited so a handler cannot register 10k watches per call, (c) filtered to
          // paths the caller actually has R on — silent-drop forbidden ones, mirroring filter-on-emit.
          const MAX_WATCH_FROM_RESULT = 100;
          const candidates = extractPaths(result).slice(0, MAX_WATCH_FROM_RESULT);
          const allowed: string[] = [];
          for (const p of candidates) {
            try { assertSafePath(p); } catch { continue; }
            const perm = await ctx.tree.getPerm(p);
            if (perm & R) allowed.push(p);
          }
          if (allowed.length) watcher.watch(ctx.session.userId, allowed);
        }
        return result;
      }),

    getTemplates: authed.query(
      async ({ ctx }) => (await ctx.tree.getChildren('/templates')).items,
    ),

    // deprecated: use execute('/sys', 'apply_template', { templatePath, targetPath })
    applyTemplate: authed
      .input(z.object({ templatePath: safePath, targetPath: safePath }))
      .mutation(({ input, ctx }) => applyTemplateOp(ctx.tree, input.templatePath, input.targetPath)),

    // R5-SRV-1: `params` removed from tRPC surface — only used by internal seed
    // bootstrap (deploySeedPrefabs → deployNodes), never reached over the wire.
    deployPrefab: authed
      .input(z.object({
        source: safePath,
        target: safePath,
        allowAbsolute: z.boolean().optional(),
      }))
      .mutation(({ input, ctx }) =>
        deployPrefabOp(ctx.tree, input.source, input.target, {
          allowAbsolute: input.allowAbsolute,
        })),

    // R4-AUTH-4: cap password length to prevent scrypt CPU DoS via multi-MB inputs.
    // 256 chars is well above any realistic password-manager output.
    register: base
      .input(z.object({ userId: z.string().min(1).max(64), password: z.string().min(1).max(256) }))
      .mutation(async ({ input, ctx }) => {
        const r = await registerUser(baseStore, input.userId, input.password, ctx.clientIp);
        // First user registers active+token; pending users have no token. Set cookie when issued.
        if (r.token) ctx.setHeader?.('Set-Cookie', buildSessionCookie(r.token));
        return r;
      }),

    login: base
      .input(z.object({ userId: z.string().min(1).max(64), password: z.string().min(1).max(256) }))
      .mutation(async ({ input, ctx }) => {
        const r = await loginUser(baseStore, input.userId, input.password, ctx.clientIp);
        ctx.setHeader?.('Set-Cookie', buildSessionCookie(r.token));
        return r;
      }),

    me: authed.query(({ ctx }) => {
      if (!ctx.session) return null;
      return { userId: ctx.session.userId };
    }),

    getPerm: authed
      .input(z.object({ path: safePath }))
      .query(async ({ input, ctx }) => ctx.tree.getPerm(input.path)),

    logout: authed.mutation(async ({ ctx }) => {
      ctx.setHeader?.('Set-Cookie', buildClearSessionCookie());
      if (!ctx.session || !ctx.token) return { ok: false };
      return logoutUser(baseStore, ctx.token);
    }),

    agentConnect: base
      .input(z.object({ path: safePath, key: z.string().min(1).max(256) }))
      .mutation(({ input, ctx }) => agentConnect(baseStore, input.path, input.key, ctx.clientIp)),

    // R4-AUTH-1: operator-side init for agent pairing. Requires auth + W on the port path
    // (enforced by ctx.tree's withAcl wrap). Closes the unauth idle→pending self-claim.
    agentInitPair: authed
      .input(z.object({ path: safePath, key: z.string().min(1).max(256) }))
      .mutation(({ input, ctx }) => agentInitPair(ctx.tree, input.path, input.key)),

    unwatch: authed.input(z.object({ paths: z.array(z.string()) })).mutation(({ input, ctx }) => {
      if (ctx.session) watcher.unwatch(ctx.session.userId, input.paths);
    }),

    unwatchChildren: authed
      .input(z.object({ paths: z.array(z.string()) }))
      .mutation(({ input, ctx }) => {
        if (ctx.session) {
          watcher.unwatch(ctx.session.userId, input.paths, { children: true });
          for (const p of input.paths) cdc?.unwatchQuery(p, ctx.session.userId);
        }
      }),

    devLogin: base.mutation(async ({ ctx }) => {
      const r = await devLogin(baseStore);
      ctx.setHeader?.('Set-Cookie', buildSessionCookie(r.token));
      return r;
    }),

    streamAction: authed
      .input(z.object({ path: safePath, type: z.string().optional(), key: z.string().optional(), action: z.string(), data: z.unknown().optional() }))
      .subscription(({ input, ctx }) => {
        return observable<unknown>((emit) => {
          const ac = new AbortController();
          (async () => {
            // Delegate to executeStream — shares resolveActionHandler + validateActionArgs with executeAction.
            // Manual handler loop here previously bypassed schema validation (allowed arbitrary `data` shape).
            const gen = executeStream(
              ctx.tree, input.path, input.type, input.key, input.action, input.data, ac.signal,
              { userId: ctx.session?.userId ?? null, claims: ctx.claims },
            );
            for await (const item of gen) {
              if (ac.signal.aborted) break;
              emit.next(item);
            }
            emit.complete();
          })().catch((err) => {
            if (!ac.signal.aborted) emit.error(err);
          });
          return () => ac.abort();
        });
      }),

    events: authed.subscription(({ ctx }) => {
      if (ctx.token && !ctx.session) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired' });
      }

      return observable<NodeEvent>((emit) => {
        const userId = ctx.session?.userId;
        if (!userId) return () => {};
        const expiresAt = typeof ctx.session?.expiresAt === 'number' ? ctx.session.expiresAt : null;
        const claims = ctx.session?.claims ?? [];
        const connId = `${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        const sessionClaims = claims.length ? claims : null;
        const push = createFilteredPush(baseStore, userId, sessionClaims, (e) => emit.next(e), { claimsTtlMs });

        let expiryTimer: ReturnType<typeof setTimeout> | null = null;
        if (expiresAt) {
          expiryTimer = setTimeout(() => {
            emit.error(new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired' }));
          }, Math.max(0, expiresAt - Date.now()));
        }

        const preserved = watcher.connect(connId, userId, push);
        emit.next({ type: 'reconnect', preserved });
        return () => {
          if (expiryTimer) clearTimeout(expiryTimer);
          watcher.disconnect(connId);
        };
      });
    }),
  });
}

export type TreeRouter = ReturnType<typeof createTreeRouter>;
