// Treenity tRPC Router — Layer 4
// Thin transport wrapper over shared ops (actions.ts).
// Responsibilities: input validation (Zod), error mapping (OpError → TRPCError), watch wiring.

import { getComponentField, isRef, type NodeData, resolve, S } from '#core';
import { assertSafePath } from '#core/path';
import type { Tree } from '#tree';
import { createTreeP } from '#protocol/treep';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import {
  type ActionCtx,
  applyTemplate as applyTemplateOp,
  executeAction,
  serverNodeHandle,
  setComponent as setComponentOp,
} from './actions';
import { buildClaims, type Session, withAcl } from './auth';
import { agentConnect, anonLogin, devLogin, loginUser, logoutUser, registerUser } from './auth-ops';
import { OpError } from './errors';
import { deployPrefab as deployPrefabOp } from './prefab';
import { type CdcRegistry, type NodeEvent } from './sub';
import { extractPaths } from './volatile';
import { type WatchManager } from './watch';
import { createFilteredPush } from './watch-filter';

export type TrpcContext = { session: Session | null; token: string | null };

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
};

const DEFAULT_CLAIMS_TTL_MS = 30_000;

export function createTreeRouter(baseStore: Tree, watcher: WatchManager, opts?: TreeRouterOpts, cdc?: CdcRegistry) {
  const claimsTtlMs = opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;
  const t = initTRPC.context<TrpcContext>().create();

  // Map domain errors → TRPCError. Base middleware for all procedures.
  function mapErrors(result: { ok: boolean; error?: { cause?: unknown } }) {
    if (result.ok) return;
    const cause = result.error?.cause;
    if (cause instanceof Error) {
      if (cause.name === 'OpError')
        throw new TRPCError({ code: (cause as OpError).code, message: cause.message });
      if (cause.message.startsWith('Access denied'))
        throw new TRPCError({ code: 'FORBIDDEN', message: cause.message });
      if (cause.message.startsWith('OptimisticConcurrencyError'))
        throw new TRPCError({ code: 'CONFLICT', message: cause.message });
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
    const tp = createTreeP(tree, (path, key, action, data) =>
      executeAction(tree, path, undefined, key, action, data, { userId }));
    return next({ ctx: { ...ctx, tree, tp } });
  });

  return t.router({
    get: authed
      .input(z.object({ path: safePath, watch: z.boolean().optional() }))
      .query(async ({ input, ctx }) => {
        const node = await ctx.tp.get(input.path);
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
        }, { ...ctx, queryContextPath: input.path });

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
          const paths = extractPaths(result);
          if (paths.length) watcher.watch(ctx.session.userId, paths);
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

    deployPrefab: authed
      .input(z.object({
        source: safePath,
        target: safePath,
        allowAbsolute: z.boolean().optional(),
        params: z.any().optional(),
      }))
      .mutation(({ input, ctx }) =>
        deployPrefabOp(ctx.tree, input.source, input.target, {
          allowAbsolute: input.allowAbsolute,
          params: input.params,
        })),

    register: base
      .input(z.object({ userId: z.string().min(1), password: z.string().min(1) }))
      .mutation(({ input }) => registerUser(baseStore, input.userId, input.password)),

    login: base
      .input(z.object({ userId: z.string().min(1), password: z.string().min(1) }))
      .mutation(({ input }) => loginUser(baseStore, input.userId, input.password)),

    me: authed.query(({ ctx }) => {
      if (!ctx.session) return null;
      return { userId: ctx.session.userId };
    }),

    getPerm: authed
      .input(z.object({ path: safePath }))
      .query(async ({ input, ctx }) => ctx.tree.getPerm(input.path)),

    logout: authed.mutation(async ({ ctx }) => {
      if (!ctx.session || !ctx.token) return { ok: false };
      return logoutUser(baseStore, ctx.token);
    }),

    agentConnect: base
      .input(z.object({ path: safePath, key: z.string().min(1) }))
      .mutation(({ input }) => agentConnect(baseStore, input.path, input.key)),

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

    anonLogin: base.mutation(() => anonLogin(baseStore)),

    devLogin: base.mutation(() => devLogin(baseStore)),

    streamAction: authed
      .input(z.object({ path: safePath, type: z.string().optional(), key: z.string().optional(), action: z.string(), data: z.unknown().optional() }))
      .subscription(({ input, ctx }) => {
        return observable<unknown>((emit) => {
          const ac = new AbortController();
          (async () => {
            const node = await ctx.tree.get(input.path);
            if (!node) {
              emit.error(new OpError('NOT_FOUND', `Node not found: ${input.path}`));
              return;
            }

            // Resolve handler: key → type lookup, type scan, node type, component scan
            let handler: any;
            let comp: { $type: string; [k: string]: unknown } | undefined;

            const [found] = getComponentField(node, input.type ?? 't.any', input.key) ?? [];
            if (input.key && !found) {
              emit.error(new OpError('NOT_FOUND', `Component "${input.key}" not found`));
              return;
            }
            if (input.type && !found) {
              emit.error(new OpError('NOT_FOUND', `Component "${input.type}" not found`));
              return;
            }
            comp = found as typeof comp;
            handler = resolve((comp ?? node).$type, `action:${input.action}`);

            if (!handler) {
              emit.error(new OpError('BAD_REQUEST', `No action "${input.action}" for type "${node.$type}"`));
              return;
            }
            const actx: ActionCtx = { node, comp, tree: ctx.tree, signal: ac.signal, nc: serverNodeHandle(ctx.tree), userId: ctx.session?.userId ?? null };
            const result = handler(actx, input.data);
            if (
              result &&
              typeof result === 'object' &&
              Symbol.asyncIterator in (result as object)
            ) {
              for await (const item of result as AsyncIterable<unknown>) {
                if (ac.signal.aborted) break;
                emit.next(item);
              }
            } else {
              const resolved = await result;
              emit.next(resolved);
            }
            emit.complete();
          })().catch((err) => {
            if (!ac.signal.aborted) emit.error(err);
          });
          return () => ac.abort();
        });
      }),

    events: authed.subscription(({ ctx }) => {
      return observable<NodeEvent>((emit) => {
        const userId = ctx.session?.userId;
        if (!userId) return () => {};
        const claims = ctx.session?.claims ?? [];
        const connId = `${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        const sessionClaims = claims.length ? claims : null;
        const push = createFilteredPush(baseStore, userId, sessionClaims, (e) => emit.next(e), { claimsTtlMs });

        const preserved = watcher.connect(connId, userId, push);
        emit.next({ type: 'reconnect', preserved });
        return () => watcher.disconnect(connId);
      });
    }),
  });
}

export type TreeRouter = ReturnType<typeof createTreeRouter>;
