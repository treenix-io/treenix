// Treenix Actions — Layer 4
// Server-specific: ActionCtx, SchemaHandler, client proxy
// Component registration lives in @/comp

import './action-context';
import { Class, type TypeProxy } from '#comp';
import { type ExecuteFn, makeTypedProxy, type StreamFn } from '#comp/handle';
import { collectDeps as _collectDeps, type ResolvedDeps } from '#comp/needs';
import { assertSafeKey, COMP_PREFIX, type ComponentData, compKey, getComponentField, getMeta, isComponent, type NodeData, normalizeType, register, resolve, resolveExact, safeJsonParse } from '#core';
import { assertSafeSchema, validateValue, type ValidationError } from '#comp/validate';
import { type TypeSchema } from '#schema/types';
import type { Session } from '#security/sessions';
import { type ExecOpts, type PatchManyEntry, type PatchOp, type Tree } from '#tree';
import { createDraft, enablePatches, finishDraft, type Patch } from 'immer';
import { randomUUID } from 'node:crypto';
import { createBoundedCache } from '#util/bounded-cache';
import { isRecord } from '#util/is-record';
import { KernelError } from '#errors';
import { commit, mutationLock } from './commit';
import { readonlyProxy, wrapAbortGuardTree, wrapReadOnlyTree } from './readonly-tree';
import { assertCanCall, runWithFrame, type KindFrame } from './kind-stack';

// Schema arrives pre-resolved (registry for static types, freshly-read stored schema for
// dynamic ones — the latter is never register()ed, see loadDynamicAction).
function validateActionArgs(type: string, action: string, data: unknown, schema: TypeSchema | undefined): void {
  const methodSchema = schema?.methods?.[action];

  if (!methodSchema) {
    throw new KernelError('INVALID', `[SECURITY] No schema for ${type}.${action} — action args not validated`);
  }

  // The caller's args are the handler's one parameter (a class method's second is the injected
  // needs), so arguments[0] is the whole args schema — unions and typeless schemas included.
  const argSchema = methodSchema.arguments?.[0];
  if (!argSchema) return;

  const errors: ValidationError[] = [];
  validateValue(data ?? {}, argSchema, `${type}.${action}`, errors);
  if (errors.length) {
    throw new KernelError('INVALID', `Invalid action args: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  }
}

// Deps that live outside the Immer draft (cross-node fetches, read-kind, streams) are
// plain copies — writes to them would be silently dropped. readonlyProxy turns such a
// write into FORBIDDEN while leaving deep reads untouched (proxy traps writes only).
function readonlyDep(dep: ResolvedDeps[string]): ResolvedDeps[string] {
  return Array.isArray(dep) ? readonlyProxy(dep.map(n => readonlyProxy(n))) : readonlyProxy(dep);
}

function immerToPatchOps(patches: Patch[]): PatchOp[] {
  return patches.map(p => {
    const path = p.path.join('.');
    if (p.op === 'remove') return ['d', path] as const;
    return [p.op === 'replace' ? 'r' : 'a', path, p.value] as const;
  });
}

export type NodeHandle = ReturnType<typeof serverNodeHandle>;

/** Actor identity + caller-context for audit trails.
 *  - `id` is a stable principal id ('user:kriz', 'agent-workload:r-7f2a', 'system:autostart').
 *  - taskPath/runPath/action/requestId are open metadata: entry points (MCP/tRPC) populate
 *    them from session metadata so audit subscribers can record "who, on which task,
 *    in which run, doing which action, as part of which request". */
export type ActorContext = {
  id: string;
  /** Human principal a workload acts for (core-3j54) — set from session metadata
   *  at the boundary that links them (mint/approval), never by the workload itself. */
  onBehalfOf?: string;
  taskPath?: string;
  runPath?: string;
  action?: string;
  requestId?: string;
};

/** Session metadata → ActorContext — THE one mapping for every entry lane
 *  (TWP wire, workload executor, MCP). An entry lane building its own inline
 *  actor drops onBehalfOf/taskPath/runPath and orphans the audit trail
 *  (core-3j54, core-anz4.14). requestId: the caller's opId when present (a
 *  replayed op keeps one id), else minted. */
export function buildActor(session: Session, action: string, requestId?: string): ActorContext {
  return {
    id: session.userId,
    action,
    requestId: requestId ?? randomUUID(),
    onBehalfOf: typeof session.onBehalfOf === 'string' ? session.onBehalfOf : undefined,
    taskPath: typeof session.taskPath === 'string' ? session.taskPath : undefined,
    runPath: typeof session.runPath === 'string' ? session.runPath : undefined,
  };
}

/** Actor-bound Tree (core-anz4.14): every mutation verb forwards its ctx with
 *  the bound ActorContext stamped in — so audit/events attribute cross-node
 *  handler writes and service writes instead of degrading to bare {id} or
 *  anonymous. Binding happens at tree construction, server side — node
 *  payloads and wire input never reach ctx, so the actor is not spoofable
 *  (same principle as ExecOpts excluding identity, tree/index.ts:120).
 *  A ctx that already carries an actor wins: only in-process code can pass
 *  ctx, and a nested lane's stamp is more specific (e.g. a per-service wrap
 *  over the autostart-level wrap). */
export function withActor<T extends Tree>(inner: T, actor: ActorContext): T {
  const stamp = (ctx: unknown): unknown => {
    if (ctx === undefined || ctx === null) return { actor };
    if (typeof ctx !== 'object') return ctx;
    if ((ctx as { actor?: unknown }).actor) return ctx;
    return { ...ctx, actor };
  };
  const bound: T = {
    ...inner,
    set: (node: NodeData, ctx?: unknown) => inner.set(node, stamp(ctx)),
    remove: (path: string, ctx?: unknown) => inner.remove(path, stamp(ctx)),
    patch: (path: string, ops: PatchOp[], ctx?: unknown) => inner.patch(path, ops, stamp(ctx)),
    ...(inner.patchMany ? {
      patchMany: (ancestor: string, entries: PatchManyEntry[], ctx?: unknown) =>
        inner.patchMany!(ancestor, entries, stamp(ctx)),
    } : {}),
  };
  return bound;
}

/** @opaque Runtime-injected, not part of public schema */
export type ActionCtx = {
  node: NodeData;
  tree: Tree;
  signal: AbortSignal;
  /** Typed client for cross-node action calls: ctx.nc(path).get(Type).method(data) */
  nc: NodeHandle;
  comp?: ComponentData;
  deps?: ResolvedDeps;
  /** User who triggered this action (null for system/anonymous) */
  userId?: string | null;
  /** Caller's claims (e.g. 'admins', 'authenticated'). Empty/undefined for system. */
  claims?: string[];
  /** Actor metadata (audit trail). See ActorContext. */
  actor?: ActorContext;
};

// ── Client proxy ──

export type { ExecuteInput } from '#comp/handle';

export function createNodeHandle(
  execute: ExecuteFn,
  stream: StreamFn,
  getNode?: (path: string) => NodeData | undefined,
) {
  return (path: string) => ({
    get<T extends object>(cls: Class<T>, key?: string): TypeProxy<T> {
      return makeTypedProxy(getNode?.(path), cls, path, execute, stream, key);
    },
  });
}
// Server-side typed node client: wraps executeAction/executeStream into createNodeHandle.
// Usage: const nc = serverNodeHandle(tree); await nc(path).get(MyComp).myMethod();
// Prefers the tree's own execute capability (core-pxlu) so nested cross-node
// calls inherit federation routing; capability-less trees (readonly facade,
// bare adapters) fall back to the local executor.
export function serverNodeHandle(tree: Tree) {
  return createNodeHandle(
    (input) => tree.execute
      ? tree.execute(input.path, input.action, input.data, { type: input.type, key: input.key })
      : executeAction(tree, input.path, input.type, input.key, input.action, input.data),
    (input) => executeStream(tree, input.path, input.type, input.key, input.action, input.data),
  );
}

export { collectDeps } from '#comp/needs';

// ── Server-side operations ──
// Single entry point for tRPC, MCP, cook-bot, services — no boilerplate.
// All ops throw KernelError for domain errors (NOT_FOUND, INVALID, CONFLICT).
enablePatches();

// Action timeout: env-configurable, default 10s.
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT) || 10_000;
// @io actions declare an external call (LLM, HTTP) — 10s starves real inference.
const IO_ACTION_TIMEOUT = Number(process.env.IO_ACTION_TIMEOUT) || 120_000;
const STREAM_TIMEOUT = Number(process.env.STREAM_TIMEOUT) || 600_000;

function withActionTimeout<T>(label: string, signal: AbortSignal, promise: Promise<T>, ms = ACTION_TIMEOUT): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`${label} timed out after ${ms}ms`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${label} timed out after ${ms}ms`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

// ── Shared resolution: find handler + component for any action call ──
// Resolution order:
//   key given → node[key], verify $type === type (if type given)
//   type given, no key → scan components for first matching $type
//   neither → node.$type, then scan components for matching action handler

type ResolvedAction = {
  node: NodeData;
  handler: (ctx: ActionCtx, data: unknown) => unknown;
  type: string;
  comp: ComponentData | undefined;
  deps: ResolvedDeps;
  fieldKey: string | undefined;
  /** Effective schema: exact registry entry, else freshly-read stored type schema, else
   *  the 'default' schema when it carries this action's method (built-in $schema/patch). */
  schema: TypeSchema | undefined;
};

// Dynamic actions: load from /sys/types/{ns}/{name} node's `actions` field.
// Code runs in QuickJS WASM sandbox — no host FS/network/process access (C01 fix).
// Sandbox gets: ctx.node (sanitized snapshot), ctx.tree.get (own node only) /
// set (own subtree, one node per call), data, console.log.

const DYNAMIC_ACTION_TIMEOUT = 5_000;
const DYNAMIC_ACTION_MEM = 8 * 1024 * 1024;

// Sandbox writes arrive as parsed JSON — a NodeData needs at least string $path/$type.
function isSandboxNodeWrite(v: Record<string, unknown>): v is NodeData {
  return typeof v.$path === 'string' && typeof v.$type === 'string';
}

type DynamicAction = {
  handler: (ctx: ActionCtx, data: unknown) => unknown;
  /** Freshly-read stored schema; undefined when the sealed registry already has one for the type. */
  schema: TypeSchema | undefined;
};

async function loadDynamicAction(
  tree: Tree, type: string, action: string,
): Promise<DynamicAction | null> {
  if (!type.includes('.')) return null;

  const typePath = `/sys/types/${type.replace(/\./g, '/')}`;
  const typeNode = await tree.get(typePath);
  // Strict: only nodes with $type === 'type' are valid type definitions. Without this an attacker
  // who can write any node at /sys/types/* — even one with arbitrary $type — could plant
  // executable `actions` and a poisoned `schema` (the latter disables validateActionArgs globally).
  if (!typeNode || typeNode.$type !== 'type') return null;
  const actions = typeNode.actions;
  const actionCode = isRecord(actions) ? actions[action] : undefined;
  if (!actionCode || typeof actionCode !== 'string') return null;

  // Stored schema is validated per call and NEVER register()ed: the sealed registry keeps
  // the first entry forever, so registering would freeze a mutable stored schema (edits
  // ignored until restart) and let a tree-writable node poison the process-wide registry.
  // Exact: resolve() falls back to the code-registered 'default' schema, which would
  // mask the stored one for every dynamic type (core-anz4.23).
  let schema: TypeSchema | undefined;
  if (!resolveExact(type, 'schema')) {
    const nodeSchema = typeNode.schema;
    if (!isRecord(nodeSchema)) return null;
    // R4-MOUNT-4: cap regex `pattern` complexity. F6 made /sys/types admin-only-write,
    // but admin typo / malicious mod can plant `pattern: '(a+)+$'` (catastrophic backtracking)
    // and DoS the single-process tenant on every action invocation.
    assertSafeSchema(nodeSchema, type);
    // Boundary decode: schema is stored JSON; validateValue treats unknown keywords as inert.
    schema = nodeSchema as TypeSchema;
  }

  // Build a sandboxed action handler — compiled once, called per invocation
  const fn = async (ctx: ActionCtx, data: unknown): Promise<unknown> => {
    if (/\bawait\b/.test(actionCode)) {
      throw new KernelError('INVALID', `Dynamic action ${type}.${action} uses await, but async bridge is not implemented`);
    }

    // Optional peer, resolved only when a stored dynamic action actually runs —
    // keeps the WASM blob out of every @treenx/core consumer's install.
    const { getQuickJS, shouldInterruptAfterDeadline } = await import('quickjs-emscripten').catch((e: Error) => {
      throw new Error(`dynamic action ${type}.${action}: optional peer 'quickjs-emscripten' failed to load — ${e.message}`);
    });
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(DYNAMIC_ACTION_MEM);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DYNAMIC_ACTION_TIMEOUT));
    const vm = runtime.newContext();

    try {
      // Inject `data` as global
      const dataHandle = vm.evalCode(`(${JSON.stringify(data ?? {})})`);
      if ('value' in dataHandle) { vm.setProp(vm.global, 'data', dataHandle.value); dataHandle.value.dispose(); }

      const nodePath = ctx.node.$path;

      // Strip security-sensitive fields before exposing the snapshot to
      // sandboxed action code (dynamic JS runs in QuickJS with sync bridge).
      const sanitized: NodeData = { ...ctx.node };
      delete sanitized.$acl;
      delete sanitized.$owner;
      delete sanitized.$refs;
      const sanitizedJson = JSON.stringify(sanitized);

      const treeWrites: Record<string, unknown>[] = [];
      let treeWriteError: string | null = null;
      let treeReadError: string | null = null;

      // Host function: ctx_tree_get(path) → JSON string. The bridge is sync and QuickJS
      // can't await host promises, so only the action's own (pre-fetched) node is readable.
      // The miss is recorded host-side too: a sandbox try/catch must not turn it into silence.
      const getFn = vm.newFunction('ctx_tree_get', (pathHandle) => {
        const p = vm.getString(pathHandle);
        if (p !== nodePath) {
          treeReadError = `Dynamic action ${type}.${action} read ${p}: sandbox reads are limited to the action's own node (${nodePath}) until an async bridge exists`;
          throw new Error(treeReadError);
        }
        return vm.newString(sanitizedJson);
      });
      vm.setProp(vm.global, 'ctx_tree_get', getFn);
      getFn.dispose();

      // Host function: ctx_tree_set(nodeJson) → void
      const setFn = vm.newFunction('ctx_tree_set', (nodeJsonHandle) => {
        const nj = vm.getString(nodeJsonHandle);
        try {
          const parsed = safeJsonParse(nj);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            treeWriteError = 'ctx.tree.set expected a node object';
            return vm.undefined;
          }
          treeWrites.push(parsed as Record<string, unknown>);
        } catch (err) {
          treeWriteError = err instanceof Error ? err.message : String(err);
        }
        return vm.undefined;
      });
      vm.setProp(vm.global, 'ctx_tree_set', setFn);
      setFn.dispose();

      // Console stub
      const logFn = vm.newFunction('log', (...args) => {
        const parts = args.map(a => vm.getString(a));
        console.log(`[sandbox:${type}.${action}]`, ...parts);
      });
      const consoleObj = vm.newObject();
      vm.setProp(consoleObj, 'log', logFn);
      vm.setProp(vm.global, 'console', consoleObj);
      consoleObj.dispose();
      logFn.dispose();

      const wrapperCode = `
        var ctx = {
          node: ${sanitizedJson},
          tree: {
            get: function(p) { return JSON.parse(ctx_tree_get(p)); },
            set: function(n) { ctx_tree_set(JSON.stringify(n)); },
          },
        };
        (function() { ${actionCode} })();
      `;

      const result = vm.evalCode(wrapperCode);
      if (result.error) {
        const err = vm.dump(result.error);
        result.error.dispose();
        // Bridge failures keep their precise error — the generic wrap below would mask them.
        if (treeReadError) throw new KernelError('INVALID', treeReadError);
        throw new Error(`Dynamic action ${type}.${action} failed: ${typeof err === 'object' && err ? err.message ?? JSON.stringify(err) : err}`);
      }

      const treeOpsResult = vm.dump(result.value);
      result.value.dispose();

      if (treeReadError) throw new KernelError('INVALID', treeReadError);
      if (treeWriteError) {
        throw new KernelError('INVALID', `Dynamic action ${type}.${action} invalid ctx.tree.set: ${treeWriteError}`);
      }

      // Validate ALL writes before applying ANY — the sandbox has no transaction, so a
      // mid-loop failure after a first tree.set would leave a partial commit behind.
      const validWrites: NodeData[] = [];
      for (const n of treeWrites) {
        if (!isSandboxNodeWrite(n)) {
          throw new KernelError('INVALID', `Dynamic action ${type}.${action} invalid ctx.tree.set: node must include string $path and $type`);
        }
        if (n.$path !== nodePath && !n.$path.startsWith(nodePath + '/')) {
          throw new KernelError('FORBIDDEN', `Dynamic action ${type}.${action} cannot write outside ${nodePath}: ${n.$path}`);
        }
        // Strip security-sensitive fields from sandbox writes.
        delete n.$acl;
        delete n.$owner;
        delete n.$refs;
        validWrites.push(n);
      }

      // tree.set/patch are atomic per path only — >1 distinct target cannot commit as one unit.
      const distinctPaths = new Set(validWrites.map(n => n.$path));
      if (distinctPaths.size > 1) {
        throw new KernelError('INVALID', `Dynamic action ${type}.${action} wrote ${distinctPaths.size} distinct paths (${[...distinctPaths].join(', ')}) — sandbox writes commit as one atomic unit; write a single node per invocation`);
      }

      // set() replaces the whole node, so sequential writes to one path collapse to the last —
      // applied as ONE commit (tree.patch can't create child nodes, set can).
      // Route through ctx.tree (read-only facade applies when parent action's kind = 'read').
      const finalWrite = validWrites.at(-1);
      if (finalWrite) await ctx.tree.set(finalWrite);

      return treeOpsResult;
    } finally {
      vm.dispose();
      runtime.dispose();
    }
  };

  // No register() — don't cache permanently. Re-evaluate from tree each time.
  // This ensures source changes take effect without server restart.
  console.warn(`[actions] loading dynamic action "${action}" for "${type}" from ${typePath}`);
  return { handler: fn, schema };
}

async function resolveActionHandler(
  tree: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
): Promise<ResolvedAction> {
  // Mask FORBIDDEN as NOT_FOUND on execute — security: don't leak existence
  // of paths the caller can't read. (tree.get throws FORBIDDEN on no read perm.)
  const node = await tree.get(path).catch((e: any) => {
    if (e?.code === 'FORBIDDEN') throw new KernelError('NOT_FOUND', `Node not found: ${path}`);
    throw e;
  });
  if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${path}`);

  const [comp, fieldKey] = getComponentField(node, componentType ?? 't.any', componentKey) ?? [];
  if (!isComponent(comp)) throw new KernelError('NOT_FOUND', `Component "${componentKey ?? componentType}" not found on ${path}`);

  const type = comp.$type;

  let deps: ResolvedDeps = await _collectDeps(node, fieldKey!, action, tree);

  // Precedence: exact registered handler → dynamic stored handler → inherited default
  // built-in. Exact-only lookups — resolve() falls back to the 'default' entries, which
  // would shadow both the stored dynamic handler/schema and a missing one (core-anz4.23).
  let handler = resolveExact(type, `action:${action}`);
  let schema = resolveExact(type, 'schema')?.();

  if (!handler) {
    // A stored type node may override the built-ins (patch/$schema) too. Safe to consult
    // before the inherited default: /sys/types is admin-only-write (F6), the code runs in
    // the QuickJS sandbox, and the stored schema passes assertSafeSchema.
    const dyn = await loadDynamicAction(tree, type, action);
    if (dyn) {
      handler = dyn.handler;
      schema ??= dyn.schema;
    } else {
      handler = resolve(type, `action:${action}`);
    }
  }
  if (!handler) throw new KernelError('INVALID', `No action "${action}" for type "${type}"`);

  // Default-schema fallback ONLY for the inherited built-in handler (identity check): an
  // exact custom or dynamic handler without a matching schema entry stays fail-closed
  // INVALID even when named 'patch'/'$schema'.
  if (!schema?.methods?.[action] && handler === resolveExact('default', `action:${action}`)) {
    const def = resolveExact('default', 'schema')?.();
    if (def?.methods?.[action]) schema = def;
  }

  return { node, handler, type, comp, deps, fieldKey, schema };
}

// ── executeAction: mutating action with Immer draft + patch collection ──
// Patches attached as $patches for subscription layer (CDC Matrix in sub.ts).
// Pure actions (no state changes) skip persist — patches.length === 0.
// Per-path lock prevents lost updates from concurrent mutations on the same
// node. The lock scope is SHARED with commit() (core-gk8.15) so action spans
// and batch commits serialize against each other in-process.
const lockAction = mutationLock;

export type ActionOpts = {
  userId?: string | null;
  claims?: string[];
  actor?: ActorContext;
  /** Client mutation id — idempotent replay (execute) + echoed as `by` on resulting events (core-gk8.1). */
  opId?: string;
};

// Idempotency (Stripe model): a replayed opId returns the first execution's
// settled outcome instead of re-applying. Agents retry on timeout by nature,
// and a timed-out action may still have committed — without this every retry
// double-applies (core-gk8.2). Failed executions are cached too: the retry
// observes the same error rather than applying a second time. opIds are
// client-generated and must be unique per logical operation.
// Keyed per user: a bare opId key would let anyone who LEARNS another user's
// opId (logs, proxy) fetch that user's cached result, bypassing ACL.
const opResults = createBoundedCache<string, Promise<unknown>>(1000);

function runIdempotent<T>(
  userId: string | null | undefined,
  opId: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([userId ?? '', opId]);
  const prior = opResults.get(key);
  if (prior) return prior as Promise<T>;

  const result = run();
  opResults.set(key, result);
  return result;
}

export function executeAction<T = unknown>(
  tree: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
  data?: unknown,
  opts?: ActionOpts,
): Promise<T> {
  const opId = opts?.opId;
  if (!opId) return runAction<T>(tree, path, componentType, componentKey, action, data, opts);

  return runIdempotent(opts?.userId, opId, () =>
    runAction<T>(tree, path, componentType, componentKey, action, data, opts));
}

// ── withExecute: Tree.execute capability wrapper (core-pxlu) ──
// Makes a tree exec-capable: local paths run executeAction against the wrapper
// itself (handlers' ctx.tree stays exec-capable, all reads/writes flow through
// the wrapped pipeline — ACL, subscriptions, audit); paths owned by a foreign
// authority (delegate probe returns an exec-capable mounted subtree) are
// DELEGATED — the remote side resolves the handler and enforces permissions
// under ITS principal (domain-owner trust model, mount token = capability).

export type DelegationInfo = { path: string; action: string; userId?: string | null; opId?: string };

/** The audit-hook subset of WithExecuteOpts — what the composition root
 *  supplies (createPipeline execHooks, core-pa3m). delegate/onDelegated stay
 *  pipeline-owned. */
export type DelegationHooks = Pick<WithExecuteOpts, 'onDelegating' | 'onDelegatedSettled'>;

export type WithExecuteOpts = {
  /** Authority probe (MountableTree.resolveActionTree). Absent = everything local. */
  delegate?: (path: string) => Promise<Tree | undefined>;
  /** Identity bound at wrap time — NEVER taken from ExecOpts (a nested handler
   *  could spoof another principal via ctx.tree.execute otherwise). opId is
   *  per-call, not identity — it arrives via ExecOpts. */
  identity?: Omit<ActionOpts, 'opId'>;
  /** Local coherence reset after a delegated execute committed remotely
   *  (cache invalidation + watch continuity break). */
  onDelegated?: (path: string, action: string) => void;
  /** Audit intent hook, supplied by the composition root / audit mod (core has
   *  no audit API). Failure ABORTS the delegation — fail closed: the
   *  user→action link is recorded before any remote side effect. */
  onDelegating?: (info: DelegationInfo) => void | Promise<void>;
  /** Audit outcome hook. A remote commit cannot be rolled back, so a failure
   *  here must not eat the result — the supplier handles it (mark unhealthy,
   *  as with-audit does); we log loudly and return the result regardless. */
  onDelegatedSettled?: (info: DelegationInfo & { ok: boolean; error?: unknown }) => void | Promise<void>;
};

export function withExecute<T extends Tree>(inner: T, opts?: WithExecuteOpts): T & Required<Pick<Tree, 'execute'>> {
  const identity = opts?.identity;

  async function delegateRun(target: Tree, path: string, action: string, data: unknown, execOpts: ExecOpts | undefined): Promise<unknown> {
    // Local check is ONLY path visibility (R) — same FORBIDDEN→NOT_FOUND mask
    // as resolveActionHandler. Everything else is the remote authority's job.
    const node = await self.get(path).catch((e: unknown) => {
      if ((e as { code?: string })?.code === 'FORBIDDEN') throw new KernelError('NOT_FOUND', `Node not found: ${path}`);
      throw e;
    });
    if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${path}`);

    // Kind-stack does not cross the wire — classify conservatively as write+io.
    // Read-kind frames therefore never delegate (fail closed).
    assertCanCall({ kind: 'write', io: true });

    const info: DelegationInfo = { path, action, userId: identity?.userId ?? null };
    if (execOpts?.opId) info.opId = execOpts.opId;
    await opts?.onDelegating?.(info);

    let result: unknown;
    try {
      result = await target.execute!(path, action, data, execOpts);
    } catch (e) {
      // Awaited in a guard: an async settled hook must not float (unhandled
      // rejection), and its failure must never MASK the remote error.
      try {
        await opts?.onDelegatedSettled?.({ ...info, ok: false, error: e });
      } catch (hookErr) {
        console.error(`[withExecute] onDelegatedSettled failed after delegated ${action} on ${path}:`, hookErr);
      }
      throw e;
    }
    opts?.onDelegated?.(path, action);
    try {
      await opts?.onDelegatedSettled?.({ ...info, ok: true });
    } catch (e) {
      // Remote already committed — swallowing the result would desync the
      // caller from reality. The supplier marks itself unhealthy; we log.
      console.error(`[withExecute] onDelegatedSettled failed after delegated ${action} on ${path}:`, e);
    }
    return result;
  }

  const self: T & Required<Pick<Tree, 'execute'>> = {
    ...inner,
    async execute(path, action, data, execOpts, _ctx) {
      const target = opts?.delegate ? await opts.delegate(path) : undefined;
      if (!target) {
        // Local authority — full executor semantics (opId dedupe inside).
        return executeAction(self, path, execOpts?.type, execOpts?.key, action, data, { ...identity, opId: execOpts?.opId });
      }
      // Delegated — same per-user opId cache as executeAction: a replay skips
      // onDelegating/remote-call/onDelegated entirely and returns the first
      // settled outcome (order: dedupe entry → intent → remote → reset → settled).
      const opId = execOpts?.opId;
      if (!opId) return delegateRun(target, path, action, data, execOpts);
      return runIdempotent(identity?.userId, opId, () =>
        delegateRun(target, path, action, data, execOpts));
    },
  };
  return self;
}

async function runAction<T = unknown>(
  tree: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
  data?: unknown,
  opts?: ActionOpts,
): Promise<T> {
  return lockAction(path, async () => {
  const { node, handler, type, deps, fieldKey, schema } = await resolveActionHandler(
    tree, path, componentType, componentKey, action,
  );

  // Pre/post condition checking (Design by Contract)
  const methodSchema = schema?.methods?.[action];
  validateActionArgs(type, action, data, schema);

  const preFields: string[] = methodSchema?.pre ?? [];
  const postFields: string[] = methodSchema?.post ?? [];
  const target = fieldKey ? node[fieldKey] as Record<string, unknown> : node as Record<string, unknown>;

  for (const f of preFields) {
    const v = target[f];
    if (v === undefined || v === null || v === '' || v === 0) {
      console.warn(`[pre] ${type}.${action}: field "${f}" is empty`);
    }
  }

  const postSnap = Object.fromEntries(postFields.map(f => [f, target[f]]));

  // Kind enforcement: default 'write' preserves existing semantics.
  // Lookup: registry-meta (programmatic register opts) → schema (JSDoc) → fallback 'write'.
  // 'read' skips Immer draft entirely and gives the handler a readonly proxy of
  // node/comp + a read-only tree facade. Any assignment (`ctx.node.x = …`,
  // `this.x = …`, `ctx.tree.set(…)`) throws FORBIDDEN immediately.
  const actionMeta = getMeta(type, `action:${action}`);
  const metaKind = actionMeta?.kind as 'read' | 'write' | undefined;
  const metaIo = actionMeta?.io as boolean | undefined;
  const kind: 'read' | 'write' = metaKind ?? methodSchema?.kind ?? 'write';
  const io: boolean = metaIo ?? methodSchema?.io ?? false;

  // Stack-based propagation check — throws BEFORE we touch the handler so
  // nested invocations don't produce partial side effects.
  assertCanCall({ kind, io });
  const frame: KindFrame = { kind, io, path, action };

  let draft: NodeData | null = null;
  let nodeForCtx: NodeData;
  let compForCtx: ComponentData | undefined;

  if (kind === 'read') {
    nodeForCtx = readonlyProxy(node);
    const rc = fieldKey ? node[fieldKey] : undefined;
    compForCtx = isComponent(rc) ? readonlyProxy(rc as ComponentData) : undefined;
    for (const key of Object.keys(deps)) deps[key] = readonlyDep(deps[key]);
  } else {
    draft = createDraft(node);
    const dc = fieldKey ? draft[fieldKey] : undefined;
    nodeForCtx = draft;
    compForCtx = isComponent(dc) ? dc as ComponentData : undefined;
    // Remap sibling deps to draft so Immer captures mutations through deps too.
    // Sibling deps live under their '#'-prefixed component key; cross-node deps
    // (different node identity) never match — those are fetched copies, so a
    // mutation would silently vanish (no patch, no persist): make it throw instead.
    for (const key of Object.keys(deps)) {
      const storageKey = COMP_PREFIX + key;
      if (deps[key] === node[storageKey]) {
        deps[key] = draft[storageKey] as ComponentData;
      } else {
        deps[key] = readonlyDep(deps[key]);
      }
    }
  }

  // Actor-bound ctx.tree (core-anz4.14): a handler's cross-node write inherits
  // this action's rich actor — without the bind, withAcl default-stamps a bare
  // {id} and audit loses action/requestId on every foreign-path write.
  const actorTree = opts?.actor ? withActor(tree, opts.actor) : tree;
  const signal = AbortSignal.timeout(io ? IO_ACTION_TIMEOUT : ACTION_TIMEOUT);
  const treeForCtx = kind === 'read' ? wrapReadOnlyTree(actorTree) : wrapAbortGuardTree(actorTree, signal);
  const nc = serverNodeHandle(treeForCtx);
  const actx: ActionCtx = { node: nodeForCtx, comp: compForCtx, deps, tree: treeForCtx, signal, nc, userId: opts?.userId, claims: opts?.claims, actor: opts?.actor };
  const result = await runWithFrame(frame, () =>
    withActionTimeout(`${type}.${action}`, signal, Promise.resolve(handler(actx, data ?? {})), io ? IO_ACTION_TIMEOUT : ACTION_TIMEOUT),
  );

  let patches: Patch[] = [];
  if (draft) {
    const nextNode = finishDraft(draft, (p) => { patches = p });
    const postTarget = fieldKey ? nextNode[fieldKey] as Record<string, unknown> : nextNode as Record<string, unknown>;
    for (const f of postFields) {
      if (postTarget[f] === postSnap[f]) {
        console.warn(`[post] ${type}.${action}: field "${f}" unchanged`);
      }
    }
    if (patches.length > 0) {
      const ops = immerToPatchOps(patches);
      // OCC: the draft was taken at node.$rev — commit only if storage still holds it.
      // Without the test op, patchViaSet re-reads fresh state and applies diffs computed
      // against the stale snapshot: silent last-write-wins for any writer that bypasses
      // the in-process lock (direct set, second pipeline, federation). core-gk8.3.
      if (node.$rev != null) ops.unshift(['t', '$rev', node.$rev]);
      try {
        // opId → events from this action's persist echo `by` (core-gk8.1);
        // actor → withAudit attributes the commit (who/task/run/requestId).
        // Without this the journal records the mutation anonymously (core-gk8.5).
        const writeCtx = opts && (opts.opId || opts.actor)
          ? { ...(opts.opId ? { opId: opts.opId } : {}), ...(opts.actor ? { actor: opts.actor } : {}) }
          : undefined;
        // The N=1 case of the one commit envelope (core-gk8.15) — reentrant
        // re-acquire of the action's own span path.
        await commit(tree, node.$path, [{ path: node.$path, ops }], writeCtx);
      } catch (e) {
        // Re-wrap with action context — commit's CONFLICT names only the path.
        if (e instanceof KernelError && e.code === 'CONFLICT') {
          throw new KernelError('CONFLICT', `OptimisticConcurrencyError: ${type}.${action} on ${node.$path} — node changed during the action (expected $rev ${node.$rev})`);
        }
        throw e;
      }
    }
  }

  return result as T;
  }); // lockAction
}

// ── executeStream: generator action — yields multiple values, no Immer draft ──
// Generator actions persist via tree.set() directly inside the generator body.

export async function* executeStream(
  tree: Tree,
  path: string,
  componentType: string | undefined,
  componentKey: string | undefined,
  action: string,
  data?: unknown,
  signal?: AbortSignal,
  opts?: ActionOpts,
): AsyncGenerator<unknown> {
  const { node, handler, type, comp, deps, schema } = await resolveActionHandler(
    tree, path, componentType, componentKey, action,
  );

  validateActionArgs(type, action, data, schema);

  // Kind envelope (core-gk8.15): streams get the same entry gate + frame as
  // actions. NO span lock, deliberately — a stream holds its lane up to
  // STREAM_TIMEOUT (600s); serializing the node that long is a liveness
  // hazard. Stream writes are individually enveloped by the pipeline instead.
  const methodSchema = schema?.methods?.[action];
  const actionMeta = getMeta(type, `action:${action}`);
  const kind: 'read' | 'write' = (actionMeta?.kind as 'read' | 'write' | undefined) ?? methodSchema?.kind ?? 'write';
  const io: boolean = (actionMeta?.io as boolean | undefined) ?? methodSchema?.io ?? false;
  assertCanCall({ kind, io });
  const frame: KindFrame = { kind, io, path, action };

  // No Immer draft for generators — they persist via ctx.tree.set. A mutation through
  // ctx.node/ctx.comp/ctx.deps would therefore be silently dropped; mirror runAction's
  // read branch so it throws FORBIDDEN instead. ctx.tree stays live for writes —
  // unless the stream is read-kind: then the tree facade denies them too.
  // Streams persist via ctx.tree.set directly — the actor bind (core-anz4.14)
  // is what attributes every one of those writes.
  const actorTree = opts?.actor ? withActor(tree, opts.actor) : tree;
  const treeForCtx = kind === 'read' ? wrapReadOnlyTree(actorTree) : actorTree;
  const nc = serverNodeHandle(treeForCtx);
  for (const key of Object.keys(deps)) deps[key] = readonlyDep(deps[key]);
  // The cap applies WITH a caller signal too: the wire always passes its
  // cancel signal, so `signal ?? timeout` let a stuck generator run forever.
  const timeout = AbortSignal.timeout(STREAM_TIMEOUT);
  const actx: ActionCtx = { node: readonlyProxy(node), comp: comp && readonlyProxy(comp), deps, tree: treeForCtx, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, nc, userId: opts?.userId, claims: opts?.claims, actor: opts?.actor };

  const result = await runWithFrame(frame, async () => handler(actx, data ?? {}));
  if (!isAsyncIterable(result))
    throw new KernelError('INVALID', `Action "${action}" is not a generator`);

  // The frame must wrap EVERY resumption: an async generator body runs in the
  // AWAITER's ALS context, so wrapping only the call above would drop the
  // frame after the first yield — nested writes would then pass assertCanCall.
  const it = result[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const r = await runWithFrame(frame, () => it.next());
      if (r.done) { completed = true; return r.value; }
      yield r.value;
    }
  } finally {
    // core-anz4.20: only ABRUPT completion (consumer break/throw) needs IteratorClose —
    // forward return() so the handler's try/finally runs. Natural end (r.done) already
    // closed the handler; calling return() again would double-close a custom iterable.
    // In-frame: the handler's finally may issue writes gated by assertCanCall.
    if (!completed) {
      const ret = it.return?.bind(it);
      if (ret) await runWithFrame(frame, () => ret());
    }
  }
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return !!v && typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

// ── setComponent: single component update with OCC ──

export async function setComponent(
  tree: Tree,
  path: string,
  name: string,
  data: Record<string, unknown>,
  rev?: number,
): Promise<void> {
  const node = await tree.get(path);
  if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${path}`);

  if (rev != null && node.$rev != null && rev !== node.$rev)
    throw new KernelError('CONFLICT', `Stale revision: expected ${rev}, got ${node.$rev}`);

  await tree.set({ ...node, [compKey(name)]: data });
}

// ── Generic patch action — deep merge data into node (Immer draft) ──
// Registered on 'default' so every type inherits it via resolve fallback.
// Guards $ fields. Deep-merges objects, replaces arrays/primitives.

function deepAssign(target: any, source: Record<string, unknown>) {
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('$')) continue;
    assertSafeKey(k);
    if (v && typeof v === 'object' && !Array.isArray(v)
      && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepAssign(target[k], v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

// Validates the built-in actions on types whose own schema lacks the method entry.
// Code-registered: the old schemas/default.json loader was dev-only and removed in
// 3943f50, silently breaking $schema/patch on schema-less types (core-anz4.23).
const DEFAULT_SCHEMA: TypeSchema = {
  $id: normalizeType('default'), // 't.default' — register() normalizes the key identically
  type: 'object',
  properties: {},
  methods: {
    $schema: { arguments: [] },
    patch: { arguments: [{ name: 'data' }] },
  },
};

export function registerBuiltinActions() {
  register('default', 'schema', () => DEFAULT_SCHEMA);
  register('default', 'action:patch', (ctx: ActionCtx, data: unknown) => {
    if (!data || typeof data !== 'object') throw new KernelError('INVALID', 'patch: data must be an object');
    deepAssign(ctx.node, data as Record<string, unknown>);
  });
}

registerBuiltinActions();
