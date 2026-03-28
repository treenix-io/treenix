// Treenity tRPC Router — Layer 4
// Thin transport wrapper over shared ops (actions.ts).
// Responsibilities: input validation (Zod), error mapping (OpError → TRPCError), watch wiring.

import { createNode, getComponentField, isComponent, isRef, type NodeData, R, resolve, S, W } from '#core';
import { assertSafePath } from '#core/path';
import type { Tree } from '#tree';
import { createTreeP } from '#protocol/treep';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import type { Operation } from 'fast-json-patch';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  type ActionCtx,
  applyTemplate as applyTemplateOp,
  executeAction,
  serverNodeHandle,
  setComponent as setComponentOp,
} from './actions';
import { AGENT_SESSION_TTL, hashAgentKey, timingSafeCompare } from './agent';
import {
  buildClaims,
  componentPerm,
  createSession,
  DUMMY_HASH,
  hashPassword,
  resolvePermission,
  revokeSession,
  type Session,
  stripComponents,
  verifyPassword,
  withAcl,
} from './auth';
import { OpError } from './errors';
import { deployPrefab as deployPrefabOp } from './prefab';
import { type CdcRegistry, type NodeEvent } from './sub';
import { extractPaths } from './volatile';
import { type WatchManager } from './watch';

export type TrpcContext = { session: Session | null; token: string | null };

/**
 * Filter RFC 6902 patch operations, removing ops that target restricted components.
 * Patch paths are like "/componentKey/field" — first segment is the node key.
 */
function filterPatches(
  patches: Operation[],
  node: NodeData,
  userId: string | null,
  claims: string[],
): Operation[] {
  return patches.filter(op => {
    // Extract first path segment: "/foo/bar" → "foo"
    const seg = op.path.split('/')[1];
    if (!seg || seg.startsWith('$')) return true; // system fields pass through
    const val = node[seg];
    if (!isComponent(val)) return true; // plain fields pass through
    // Component — check component-level R permission
    return !!(componentPerm(val, userId, claims, node.$owner) & R);
  });
}

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

// ── Rate limiter (in-memory, per key) ──

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_AUTH = 10; // max attempts per key per minute

function checkRate(key: string, limit = RATE_LIMIT_AUTH): void {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  if (bucket.count >= limit) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests' });
  bucket.count++;
}

// Periodic cleanup (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 5 * 60_000).unref();

export type TreeRouterOpts = {
  /** TTL for cached claims in SSE connections (ms). Default 30s. 0 = no cache. */
  claimsTtlMs?: number;
};

const DEFAULT_CLAIMS_TTL_MS = 30_000;

export function createTreeRouter(baseStore: Tree, watcher: WatchManager, opts?: TreeRouterOpts, cdc?: CdcRegistry) {
  const claimsTtlMs = opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;
  const t = initTRPC.context<TrpcContext>().create();

  // Map domain errors → TRPCError by inspecting result.error.cause
  // tRPC v11 middleware: next() returns { ok, error } — doesn't throw
  const authed = t.procedure.use(async ({ ctx, next }) => {
    const userId = ctx.session?.userId ?? null;
    // Session-level claims (agents) override dynamic buildClaims (users)
    const claims = ctx.session?.claims ?? (userId ? await buildClaims(baseStore, userId) : ['public']);
    const tree = withAcl(baseStore, userId, claims);
    const tp = createTreeP(tree, (path, key, action, data) =>
      executeAction(tree, path, undefined, key, action, data, { userId }));

    const result = await next({ ctx: { ...ctx, tree, tp } });

    if (!result.ok) {
      const cause = result.error.cause;
      if (cause instanceof Error) {
        if (cause.name === 'OpError')
          throw new TRPCError({ code: (cause as OpError).code, message: cause.message });
        if (cause.message.startsWith('Access denied'))
          throw new TRPCError({ code: 'FORBIDDEN', message: cause.message });
        if (cause.message.startsWith('OptimisticConcurrencyError'))
          throw new TRPCError({ code: 'CONFLICT', message: cause.message });
      }
    }
    return result;
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

    register: t.procedure
      .input(z.object({ userId: z.string().min(1), password: z.string().min(1) }))
      .mutation(async ({ input }) => {
        checkRate(`register:${input.userId}`);
        if (/[/\\\0]/.test(input.userId)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid userId' });
        const userPath = `/auth/users/${input.userId}`;
        const existing = await baseStore.get(userPath);
        if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'User already exists' });
        // First user → admin + active, rest → pending activation by admin
        const { items } = await baseStore.getChildren('/auth/users', { limit: 1 });
        const isFirstUser = items.length === 0;

        const hash = await hashPassword(input.password);
        const node = createNode(userPath, 'user', {
          status: isFirstUser ? 'active' : 'pending',
        }, {
          credentials: { $type: 'credentials', hash },
          groups: { $type: 'groups', list: isFirstUser ? ['admins'] : [] },
        });
        node.$owner = input.userId;
        node.$acl = [
          { g: 'owner', p: R | W },
          { g: 'authenticated', p: 0 },
        ];
        console.log(`[register] writing user to ${node.$path}`);
        await baseStore.set(node);
        console.log(`[register] set() done, verifying...`);
        const verify = await baseStore.get(node.$path);
        console.log(`[register] verify get: ${verify ? 'found' : 'NOT FOUND'}`);
        if (!isFirstUser) {
          return { token: null, userId: input.userId, pending: true };
        }
        const token = await createSession(baseStore, input.userId);
        return { token, userId: input.userId, pending: false };
      }),

    login: t.procedure
      .input(z.object({ userId: z.string().min(1), password: z.string().min(1) }))
      .mutation(async ({ input }) => {
        checkRate(`login:${input.userId}`);
        if (/[/\\\0]/.test(input.userId)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid userId' });
        const userPath = `/auth/users/${input.userId}`;
        const user = await baseStore.get(userPath);
        const cv = user ? user['credentials'] : undefined;
        const creds = isComponent(cv) ? cv : undefined;
        // Always run scrypt to prevent timing-based user enumeration
        const hash = typeof creds?.['hash'] === 'string' ? creds['hash'] : undefined;
        const ok = await verifyPassword(input.password, hash ?? DUMMY_HASH);
        if (!user || !hash || !ok) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
        if (user.status !== 'active') throw new TRPCError({ code: 'FORBIDDEN', message: 'Account not activated' });
        const token = await createSession(baseStore, input.userId);
        return { token, userId: input.userId };
      }),

    me: authed.query(({ ctx }) => {
      if (!ctx.session) return null;
      return { userId: ctx.session.userId };
    }),

    getPerm: authed
      .input(z.object({ path: safePath }))
      .query(async ({ input, ctx }) => ctx.tree.getPerm(input.path)),

    logout: authed.mutation(async ({ ctx }) => {
      if (!ctx.session || !ctx.token) return { ok: false };
      await revokeSession(baseStore, ctx.token);
      return { ok: true };
    }),

    // Agent TOFU handshake — public endpoint (no auth required)
    agentConnect: t.procedure
      .input(z.object({ path: safePath, key: z.string().min(1) }))
      .mutation(async ({ input }) => {
        checkRate(`agent:${input.path}`);
        const node = await baseStore.get(input.path);
        if (!node) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent port not found' });
        if (node.$type !== 't.agent.port') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an agent port' });

        const keyHash = hashAgentKey(input.key);
        const status = (node as any).status as string ?? 'idle';

        if (status === 'revoked')
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Agent access revoked' });

        // TOFU: first key presented goes to pending
        if (status === 'idle') {
          await baseStore.set({ ...node, status: 'pending', pendingKey: keyHash });
          return { status: 'pending' as const };
        }

        // Pending: same key = still waiting, different key = reject
        if (status === 'pending') {
          if (!timingSafeCompare(keyHash, (node as any).pendingKey))
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Key mismatch' });
          return { status: 'pending' as const };
        }

        // Approved: verify key, create session
        if (status === 'approved') {
          if (!timingSafeCompare(keyHash, (node as any).approvedKey))
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Key mismatch' });

          const agentUserId = `agent:${input.path}`;
          const token = await createSession(baseStore, agentUserId, { ttlMs: AGENT_SESSION_TTL });

          // Mark connected
          await baseStore.set({ ...node, connected: true, connectedAt: Date.now() });

          return { status: 'approved' as const, token, userId: agentUserId };
        }

        throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown agent status: ${status}` });
      }),

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

    anonLogin: t.procedure.mutation(async () => {
      checkRate('anonLogin', 30);
      const userId = `anon:${randomBytes(16).toString('hex')}`;
      const token = await createSession(baseStore, userId);
      return { token, userId };
    }),

    devLogin: t.procedure.mutation(async () => {
      if (!process.env.VITE_DEV_LOGIN) throw new TRPCError({ code: 'FORBIDDEN', message: 'Dev-only' });
      const userId = 'dev';
      const userPath = `/auth/users/${userId}`;
      if (!await baseStore.get(userPath)) {
        const node = createNode(userPath, 'user', {}, {
          groups: { $type: 'groups', list: ['admins'] },
        });
        node.$owner = userId;
        await baseStore.set(node);
      }
      const token = await createSession(baseStore, userId);
      return { token, userId };
    }),

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

        // Session-provided claims (agents) are static — never refetch.
        // Dynamic claims (users) use TTL cache for authorization freshness.
        const sessionClaims = claims.length ? claims : null;
        let dynamicClaims: string[] | null = null;
        let dynamicAt = 0;
        const getClaims = async () => {
          if (sessionClaims) return sessionClaims;
          if (!dynamicClaims || Date.now() - dynamicAt > claimsTtlMs) {
            dynamicClaims = await buildClaims(baseStore, userId);
            dynamicAt = Date.now();
          }
          return dynamicClaims;
        };

        const filteredPush = async (event: NodeEvent) => {
          if (event.type === 'reconnect') { emit.next(event); return; }

          // ACL check: verify user can still read this path
          const userClaims = await getClaims();
          const perm = await resolvePermission(baseStore, event.path, userId, userClaims);
          if (!(perm & R)) return; // silently drop — user lost read access

          if (event.type === 'set' && event.node) {
            // Strip forbidden components from full node
            const fullNode = { $path: event.path, ...event.node } as NodeData;
            const stripped = stripComponents(fullNode, userId, userClaims);
            const { $path, ...body } = stripped;
            emit.next({ ...event, node: body });
          } else if (event.type === 'patch' && event.patches.length > 0) {
            // Filter patch ops targeting restricted components
            const node = await baseStore.get(event.path);
            if (!node) { emit.next(event); return; }
            const filtered = filterPatches(event.patches, node, userId, userClaims);
            if (filtered.length === 0) return; // all ops were restricted — skip entirely
            emit.next(filtered.length === event.patches.length ? event : { ...event, patches: filtered });
          } else {
            emit.next(event);
          }
        };

        const preserved = watcher.connect(connId, userId, (event) => { filteredPush(event).catch(() => {}); });
        emit.next({ type: 'reconnect', preserved });
        return () => watcher.disconnect(connId);
      });
    }),
  });
}

export type TreeRouter = ReturnType<typeof createTreeRouter>;
