// Treenix tRPC Router — transport binding over the TWP wire session (wire.ts).
// Responsibilities: input validation (Zod), frame err → TRPCError mapping,
// HTTP-specific auth procedures (cookies), SSE subscription bridging.
// Tree/action/watch logic lives in createWireSession — shared by all bindings.

import type { NodeData } from '#core';
import { assertSafePath } from '#core/path';
import type { Page, Tree } from '#tree';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
// Pin @trpc/server internal types to a public subpath so declaration emit stays portable (TS2742).
import type {} from '@trpc/server/unstable-core-do-not-import';
import { z } from 'zod';
import { agentConnect, agentInitPair } from '#agent-port/ops';
import { buildClearSessionCookie, buildSessionCookie } from '#security/cookies';
import type { Session } from '#security/sessions';
import { devLogin, loginUser, logoutUser, registerUser } from '#security/ops';
import { OpError } from '#errors';
import type { ErrFrame, ResFrame } from '#protocol/frames';
import { type WireEvent } from '#sub';
import { type WatchManager } from '#sub/watch';
import { setComponent as setComponentOp } from './actions';
import { deployPrefab as deployPrefabOp } from './prefab';
import { createWireSession, type SessionExecutor, type WireDeps } from './wire';

export type { SessionExecutor } from './wire';

export type TrpcContext = {
  /** Always present — outer handler issues anon session if no credential supplied. */
  session: Session;
  token: string;
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

export type TreeRouterOpts = {
  /** TTL for cached claims in SSE connections (ms). Default 30s. 0 = no cache. */
  claimsTtlMs?: number;
  /** Optional dispatcher for workload-bound sessions (those with `session.scopeRef`).
   *  When undefined, all sessions go through plain executeAction — zero overhead. */
  executor?: SessionExecutor;
  /** Tree.execute delegation wiring (core-pxlu) — set by createPipeline, not by callers. */
  exec?: WireDeps['exec'];
};

export const SSE_PING_INTERVAL_MS = 15_000;
export const SSE_RECONNECT_AFTER_INACTIVITY_MS = 60_000;

function expectUnary(r: Promise<ResFrame> | AsyncIterable<ResFrame>): Promise<ResFrame> {
  if (Symbol.asyncIterator in r) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'twp: unary op returned a stream' });
  }
  return r;
}

function frameError(err: ErrFrame['err']): Error {
  return err.code === 'INTERNAL'
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.msg })
    : new OpError(err.code, err.msg);
}

/** Frame → procedure result. T states the procedure's contract; the frame
 *  payload is untrusted wire data, so this is the decode boundary. */
async function unwrap<T>(r: Promise<ResFrame> | AsyncIterable<ResFrame>): Promise<T> {
  const f = await expectUnary(r);
  if ('err' in f) throw frameError(f.err);
  if ('ok' in f) return f.ok as T;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'twp: unexpected frame for unary op' });
}

export function createTreeRouter(tree: Tree, systemTree: Tree, watcher: WatchManager, opts?: TreeRouterOpts) {
  const deps: WireDeps = {
    tree, systemTree, watcher,
    opts: { claimsTtlMs: opts?.claimsTtlMs, executor: opts?.executor },
    exec: opts?.exec,
  };

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
      // Domain code → TRPCError code. Codes not in tRPC's enum map onto closest peer.
      const code = cause.code === 'KIND_VIOLATION' ? 'FORBIDDEN'
        : cause.code === 'RESOURCE_EXHAUSTED' ? 'TOO_MANY_REQUESTS'
        : cause.code;
      throw new TRPCError({ code, message: cause.message });
    }
  }

  const base = t.procedure.use(async ({ next }) => {
    const result = await next();
    mapErrors(result);
    return result;
  });

  // withSession — anon OK. Session invariant guaranteed by outer HTTP handler;
  // no fallback to ['public'] — that was the silent-downgrade hole (core-t9d).
  const withSession = base.use(async ({ ctx, next }) => {
    // Workload guard stays at the boundary so non-TWP procedures (deployPrefab,
    // setComponent, agentInitPair) fail closed too — not only frame-dispatched ops.
    if (ctx.session.scopeRef && !opts?.executor) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR',
        message: 'workload session present but no executor configured' });
    }
    const wire = createWireSession(deps, ctx.session);
    return next({ ctx: { ...ctx, wire } });
  });

  // authed — withSession + login-required. Anon (publicly-issued) gets UNAUTHORIZED.
  // Use for endpoints semantically only valid for logged-in users (deployPrefab, agentInitPair).
  const authed = withSession.use(async ({ ctx, next }) => {
    if (ctx.session.anonymous) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'login required' });
    }
    return next();
  });

  return t.router({
    get: withSession
      .input(z.object({ path: safePath, watch: z.boolean().optional() }))
      .query(({ input, ctx }) =>
        unwrap<NodeData | undefined>(ctx.wire.handle({ id: 0, op: 'get', path: input.path, watch: input.watch }))),

    // Fetch node + resolve $ref targets. Returns [requested, ...resolved].
    resolve: withSession
      .input(z.object({ path: safePath, watch: z.boolean().optional() }))
      .query(({ input, ctx }) =>
        unwrap<NodeData[]>(ctx.wire.handle({ id: 0, op: 'resolve', path: input.path, watch: input.watch }))),

    getChildren: withSession
      .input(
        z.object({
          path: safePath,
          limit: z.number().optional().default(100),
          depth: z.number().optional(), // levels to descend; -1 = all descendants (deep). Default 1.
          query: z.record(z.string(), z.unknown()).optional(), // callerWhere (core-92z)
          cursor: z.string().optional(), // resume token from Page.nextCursor
          watch: z.boolean().optional(),
          watchNew: z.boolean().optional(),
        }),
      )
      .query(({ input, ctx }) =>
        // ctx threaded into the tree call (getChildren only) — parity with the pre-TWP router.
        unwrap<Page<NodeData>>(ctx.wire.handle({
          id: 0, op: 'ls', path: input.path,
          limit: input.limit, depth: input.depth,
          query: input.query, cursor: input.cursor,
          watch: input.watch, watchList: input.watchNew,
        }, ctx))),

    set: withSession
      .input(z.object({
        node: z.record(z.string(), z.unknown()).refine(n => typeof n.$path === 'string', '$path required'),
        opId: z.string().min(1).max(128).optional(),
      }))
      .mutation(({ input, ctx }) => {
        const path = input.node.$path;
        if (typeof path !== 'string') throw new OpError('BAD_REQUEST', '$path required');
        return unwrap<void>(ctx.wire.handle({ id: 0, op: 'set', path, node: input.node, opId: input.opId }));
      }),

    patch: withSession
      .input(z.object({ path: safePath, ops: patchOps, opId: z.string().min(1).max(128).optional() }))
      .mutation(({ input, ctx }) =>
        unwrap<void>(ctx.wire.handle({ id: 0, op: 'patch', path: input.path, ops: input.ops, opId: input.opId }))),

    setComponent: withSession
      .input(
        z.object({ path: safePath, name: z.string(), data: z.record(z.string(), z.unknown()), rev: z.number().optional() }),
      )
      .mutation(async ({ input, ctx }) => {
        const { tree: userTree } = await ctx.wire.scope();
        return setComponentOp(userTree, input.path, input.name, input.data, input.rev);
      }),

    remove: withSession
      .input(z.object({ path: safePath, opId: z.string().min(1).max(128).optional() }))
      .mutation(({ input, ctx }) =>
        unwrap<boolean>(ctx.wire.handle({ id: 0, op: 'rm', path: input.path, opId: input.opId }))),

    execute: withSession
      .input(
        z.object({
          path: safePath,
          type: z.string().optional(),   // $type for component verification
          key: z.string().optional(),    // field key for component selection
          action: z.string(),
          data: z.unknown().optional(),
          watch: z.boolean().optional(), // subscribe to paths returned in result
          opId: z.string().min(1).max(128).optional(), // idempotency key — replays return the first result
        }),
      )
      .mutation(({ input, ctx }) =>
        unwrap<unknown>(ctx.wire.handle({
          id: 0, op: 'act', path: input.path,
          type: input.type, key: input.key, action: input.action,
          data: input.data, opId: input.opId, watch: input.watch,
        }))),

    // R5-SRV-1: `params` removed from tRPC surface — only used by internal seed
    // bootstrap (deploySeedPrefabs → deployNodes), never reached over the wire.
    deployPrefab: authed
      .input(z.object({
        source: safePath,
        target: safePath,
        allowAbsolute: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { tree: userTree } = await ctx.wire.scope();
        return deployPrefabOp(userTree, input.source, input.target, {
          allowAbsolute: input.allowAbsolute,
        });
      }),

    // R4-AUTH-4: cap password length to prevent scrypt CPU DoS via multi-MB inputs.
    // 256 chars is well above any realistic password-manager output.
    register: base
      .input(z.object({ userId: z.string().min(1).max(64), password: z.string().min(1).max(256) }))
      .mutation(async ({ input, ctx }) => {
        const r = await registerUser(systemTree, input.userId, input.password, ctx.clientIp);
        // First user registers active+token; pending users have no token. Set cookie when issued.
        if (r.token) ctx.setHeader?.('Set-Cookie', buildSessionCookie(r.token));
        return r;
      }),

    login: base
      .input(z.object({ userId: z.string().min(1).max(64), password: z.string().min(1).max(256) }))
      .mutation(async ({ input, ctx }) => {
        const r = await loginUser(systemTree, input.userId, input.password, ctx.clientIp);
        ctx.setHeader?.('Set-Cookie', buildSessionCookie(r.token));
        return r;
      }),

    me: withSession.query(({ ctx }) => {
      // Auth-state probe: anon is logged-out per use-auth.ts:40 (setAuthed(res?.userId ?? null)).
      // Returning a userId for anon would make existing UI think anon is logged-in.
      if (ctx.session.anonymous) return null;
      return { userId: ctx.session.userId };
    }),

    getPerm: withSession
      .input(z.object({ path: safePath }))
      .query(({ input, ctx }) =>
        unwrap<number>(ctx.wire.handle({ id: 0, op: 'perm', path: input.path }))),

    logout: withSession.mutation(async ({ ctx }) => {
      // Idempotent for anon (cookie cleared, no persisted node to revoke) and authed
      // (cookie cleared, session node removed). logoutUser is a no-op for signed anon tokens.
      ctx.setHeader?.('Set-Cookie', buildClearSessionCookie());
      return logoutUser(systemTree, ctx.token);
    }),

    agentConnect: base
      .input(z.object({ path: safePath, key: z.string().min(1).max(256) }))
      .mutation(({ input, ctx }) => agentConnect(systemTree, input.path, input.key, ctx.clientIp)),

    // R4-AUTH-1: operator-side init for agent pairing. Requires auth + W on the port path
    // (enforced by the wire scope's withAcl wrap). Closes the unauth idle→pending self-claim.
    agentInitPair: authed
      .input(z.object({ path: safePath, key: z.string().min(1).max(256) }))
      .mutation(async ({ input, ctx }) => {
        const { tree: userTree } = await ctx.wire.scope();
        return agentInitPair(userTree, input.path, input.key);
      }),

    unwatch: withSession.input(z.object({ paths: z.array(safePath) })).mutation(({ input, ctx }) =>
      unwrap<void>(ctx.wire.handle({ id: 0, op: 'unsub', paths: input.paths }))),

    unwatchChildren: withSession
      .input(z.object({ paths: z.array(safePath) }))
      .mutation(({ input, ctx }) =>
        unwrap<void>(ctx.wire.handle({ id: 0, op: 'unsub', prefixes: input.paths }))),

    devLogin: base.mutation(async ({ ctx }) => {
      const r = await devLogin(systemTree);
      ctx.setHeader?.('Set-Cookie', buildSessionCookie(r.token));
      return r;
    }),

    streamAction: withSession
      .input(z.object({ path: safePath, type: z.string().optional(), key: z.string().optional(), action: z.string(), data: z.unknown().optional() }))
      .subscription(({ input, ctx }) => {
        return observable<unknown>((emit) => {
          const r = ctx.wire.handle({
            id: 0, op: 'act', stream: true, path: input.path,
            type: input.type, key: input.key, action: input.action, data: input.data,
          });
          if (!(Symbol.asyncIterator in r)) {
            emit.error(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'twp: expected stream' }));
            return () => {};
          }
          const it = r[Symbol.asyncIterator]();
          (async () => {
            for (;;) {
              const { value: f, done } = await it.next();
              if (done || !f) { emit.complete(); return; }
              if ('ch' in f) emit.next(f.ch);
              else if ('end' in f) { emit.complete(); return; }
              else if ('err' in f) { emit.error(frameError(f.err)); return; }
            }
          })().catch((err) => {
            emit.error(err instanceof Error ? err : new Error(String(err)));
          });
          // Teardown closes the frame stream, which aborts the handler's signal (peer finally).
          return () => { void it.return?.(); };
        });
      }),

    events: withSession
      // since = last seq the client processed — ring replay on resubscribe (core-gk8.1)
      .input(z.object({ since: z.number().int().nonnegative().optional() }).optional())
      .subscription(({ input, ctx }) => {
      if (ctx.token && !ctx.session) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired' });
      }

      return observable<WireEvent>((emit) => {
        const userId = ctx.session?.userId;
        if (!userId) return () => {};
        const expiresAt = typeof ctx.session?.expiresAt === 'number' ? ctx.session.expiresAt : null;

        let expiryTimer: ReturnType<typeof setTimeout> | null = null;
        if (expiresAt) {
          expiryTimer = setTimeout(() => {
            emit.error(new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired' }));
          }, Math.max(0, expiresAt - Date.now()));
        }

        const { connId, preserved } = ctx.wire.connectEvents((e) => emit.next(e), input?.since);
        emit.next({ type: 'reconnect', preserved });
        return () => {
          if (expiryTimer) clearTimeout(expiryTimer);
          ctx.wire.disconnectEvents(connId);
        };
      });
    }),
  });
}

export type TreeRouter = ReturnType<typeof createTreeRouter>;
