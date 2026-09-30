// Treenix tRPC Router — transport binding over the TWP wire session (wire.ts).
// Responsibilities: input validation (Zod), frame err → TRPCError mapping,
// HTTP-specific auth procedures (cookies), SSE subscription bridging.
// Tree/action/watch logic lives in createWireSession — shared by all bindings.

import type { NodeData } from '#core';
import { assertSafePath } from '#core/path';
import type { Page, Tree } from '#tree';
import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
import { observable } from '@trpc/server/observable';
// The retry codes the tRPC client itself imports. This subpath also pins @trpc/server internal types for a
// portable declaration emit (TS2742).
import { retryableRpcCodes, TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/unstable-core-do-not-import';
import { z } from 'zod';
import { agentConnect, agentInitPair } from '#agent-port/ops';
import { buildClearSessionCookie, buildSessionCookie } from '#security/cookies';
import type { Session } from '#security/sessions';
import { devLogin, loginUser, logoutUser, registerUser } from '#security/ops';
import { KernelError } from '#errors';
import type { ErrorCode } from '#kernel/types';
import type { ErrFrame, ResFrame } from '#protocol/frames';
import { type WireEvent } from '#sub';
import { type StampedEvent, type WatchManager } from '#sub/watch';
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
    // No server log: the rejection goes back to the caller, and every console
    // line persists as a /sys/logs node — an anon client could append one per request.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
  }
});

/** Watch-ownership token (core-anz4.28): scopes registration/release to one tab.
 *  Same constraint as the events-subscription token — the two must interoperate. */
const watchToken = z.string().min(1).max(256).optional();

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

const MAX_TIMER_MS = 2 ** 31 - 1;

export const SSE_PING_INTERVAL_MS = 15_000;
export const SSE_RECONNECT_AFTER_INACTIVITY_MS = 60_000;

function expectUnary(r: Promise<ResFrame> | AsyncIterable<ResFrame>): Promise<ResFrame> {
  if (Symbol.asyncIterator in r) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'twp: unary op returned a stream' });
  }
  return r;
}

// UNAUTHENTICATED rides UNAUTHORIZED: the React client signs in again on it.
// UNKNOWN_OUTCOME stays off CONFLICT and off the 5xx codes the tRPC client
// retries: re-executing a request whose outcome is unknown is forbidden.
const TRPC_CODE: Record<ErrorCode, TRPC_ERROR_CODE_KEY> = {
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INVALID: 'BAD_REQUEST',
  UNKNOWN_TYPE: 'BAD_REQUEST',
  CROSS_DOMAIN: 'BAD_REQUEST',
  READ_ONLY: 'METHOD_NOT_SUPPORTED',
  BUDGET: 'TOO_MANY_REQUESTS',
  REFUSED: 'TOO_MANY_REQUESTS',
  UNKNOWN_OUTCOME: 'PRECONDITION_FAILED',
  EXPIRED: 'PRECONDITION_FAILED',
  KEY_REUSED: 'UNPROCESSABLE_CONTENT',
  UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GENERATION: 'PRECONDITION_FAILED',
  CANCELLED: 'CLIENT_CLOSED_REQUEST',
  UNAUTHENTICATED: 'UNAUTHORIZED',
};

function toTrpcError(code: ErrorCode, message: string): TRPCError {
  return new TRPCError({ code: TRPC_CODE[code], message });
}

function frameError(err: ErrFrame['err']): TRPCError {
  return err.code === 'INTERNAL'
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.msg })
    : toTrpcError(err.code, err.msg);
}

// A stream that ends in an error the SSE client reconnects on runs the action again, though earlier steps may
// have committed, so such an error travels as UNKNOWN_OUTCOME does. The client decides by the JSON-RPC number,
// which several tRPC codes share.
function streamError(err: ErrFrame['err']): TRPCError {
  const error = frameError(err);
  if (retryableRpcCodes.includes(TRPC_ERROR_CODES_BY_KEY[error.code])) return toTrpcError('UNKNOWN_OUTCOME', err.msg);
  return error;
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
    if (cause instanceof KernelError) throw toTrpcError(cause.code, cause.message);
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
      .input(z.object({ path: safePath, watch: z.boolean().optional(), token: watchToken }))
      .query(({ input, ctx }) =>
        unwrap<NodeData | undefined>(ctx.wire.handle({ id: 0, op: 'get', path: input.path, watch: input.watch, token: input.token }))),

    // Fetch node + resolve $ref targets. Returns [requested, ...resolved].
    resolve: withSession
      .input(z.object({ path: safePath, watch: z.boolean().optional(), token: watchToken }))
      .query(({ input, ctx }) =>
        unwrap<NodeData[]>(ctx.wire.handle({ id: 0, op: 'resolve', path: input.path, watch: input.watch, token: input.token }))),

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
          token: watchToken,
        }),
      )
      .query(({ input, ctx }) =>
        // ctx threaded into the tree call (getChildren only) — parity with the pre-TWP router.
        unwrap<Page<NodeData>>(ctx.wire.handle({
          id: 0, op: 'ls', path: input.path,
          limit: input.limit, depth: input.depth,
          query: input.query, cursor: input.cursor,
          watch: input.watch, watchList: input.watchNew,
          token: input.token,
        }, ctx))),

    set: withSession
      .input(z.object({
        node: z.record(z.string(), z.unknown()).refine(n => typeof n.$path === 'string', '$path required'),
        opId: z.string().min(1).max(128).optional(),
      }))
      .mutation(({ input, ctx }) => {
        const path = input.node.$path;
        if (typeof path !== 'string') throw new KernelError('INVALID', '$path required');
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
          token: watchToken,
        }),
      )
      .mutation(({ input, ctx }) =>
        unwrap<unknown>(ctx.wire.handle({
          id: 0, op: 'act', path: input.path,
          type: input.type, key: input.key, action: input.action,
          data: input.data, opId: input.opId, watch: input.watch,
          token: input.token,
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

    unwatch: withSession.input(z.object({ paths: z.array(safePath), token: watchToken })).mutation(({ input, ctx }) =>
      unwrap<void>(ctx.wire.handle({ id: 0, op: 'unsub', paths: input.paths, token: input.token }))),

    unwatchChildren: withSession
      .input(z.object({ paths: z.array(safePath), token: watchToken }))
      .mutation(({ input, ctx }) =>
        unwrap<void>(ctx.wire.handle({ id: 0, op: 'unsub', prefixes: input.paths, token: input.token }))),

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
            emit.error(streamError({ code: 'INTERNAL', msg: 'twp: expected stream' }));
            return () => {};
          }
          const it = r[Symbol.asyncIterator]();
          (async () => {
            for (;;) {
              const { value: f, done } = await it.next();
              if (done || !f) { emit.complete(); return; }
              if ('ch' in f) emit.next(f.ch);
              else if ('end' in f) { emit.complete(); return; }
              else if ('err' in f) { emit.error(streamError(f.err)); return; }
            }
          })().catch((err) => {
            console.error('[trpc] streamAction frame stream failed:', err);
            emit.error(streamError({ code: 'INTERNAL', msg: err instanceof Error ? err.message : String(err) }));
          });
          // Teardown closes the frame stream, which aborts the handler's signal (peer finally).
          return () => { void it.return?.(); };
        });
      }),

    events: withSession
      // since = last seq the client processed — ring replay on resubscribe (core-gk8.1).
      // epoch = the stream epoch that seq was issued under (core-anz4.10); token =
      // watch-ownership scope for this tab (core-anz4.12). A since without epoch
      // is answered preserved:false — fail closed.
      .input(z.object({
        since: z.number().int().nonnegative().optional(),
        epoch: z.string().optional(),
        token: z.string().min(1).max(256).optional(),
      }).optional())
      .subscription(({ input, ctx }) => {
      if (ctx.token && !ctx.session) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired' });
      }

      return observable<WireEvent>((emit) => {
        const userId = ctx.session?.userId;
        if (!userId) return () => {};
        const expiresAt = typeof ctx.session?.expiresAt === 'number' ? ctx.session.expiresAt : null;

        // setTimeout caps at 2^31-1 ms and fires at once beyond it: a 10-year
        // API-token lane was killed right after connect. Re-arm until due.
        let expiryTimer: ReturnType<typeof setTimeout> | null = null;
        const armExpiry = (at: number) => {
          const left = Math.max(0, at - Date.now());
          expiryTimer = setTimeout(left > MAX_TIMER_MS
            ? () => armExpiry(at)
            : () => emit.error(new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired' })),
          Math.min(left, MAX_TIMER_MS));
        };
        if (expiresAt) armExpiry(expiresAt);

        const resume = input?.epoch !== undefined && input?.since !== undefined
          ? { seq: input.since, epoch: input.epoch }
          : input?.since;
        const { connId, preserved, seq, epoch } = ctx.wire.connectEvents((e) => emit.next(e), resume, input?.token);
        // Initial verdict carries the stream {seq, epoch} (anz4.28e) — without
        // it a quiet/dirty-only client resumes epoch-less and reset-loops forever.
        const verdict: StampedEvent = { type: 'reconnect', preserved, seq, epoch };
        emit.next(verdict);
        return () => {
          if (expiryTimer) clearTimeout(expiryTimer);
          ctx.wire.disconnectEvents(connId);
        };
      });
    }),
  });
}

export type TreeRouter = ReturnType<typeof createTreeRouter>;
