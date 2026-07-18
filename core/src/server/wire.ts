// TWP server session — the transport-agnostic serving side (docs/research/twp-spec.md §8).
// The ONE place where ACL/claims/watch/CDC wiring meets the protocol: every
// binding (tRPC today; postMessage/WS/HTTP next, core-nin.3+) wraps this.
// Extracted from the tRPC withSession middleware + events subscription body.

import { OpError } from '#errors';
import type { ResolvedReadPlan } from '#mount/resolve-plan';
import type { EventFrame } from '#protocol/frames';
import { createPeer, type ActReq, type Conn, type ListRegistration, type PeerServe, type ServeHooks } from '#protocol/peer';
import { withAcl, type AclStore } from '#security/acl-tree';
import { buildClaims } from '#security/claims';
import type { Session } from '#security/sessions';
import { type InvalidateEvent, type WireEvent } from '#sub';
import { type ConnectVerdict, type StampedEvent, type WatchCursor, type WatchManager } from '#sub/watch';
import { createFilteredPush } from '#sub/watch-filter';
import type { Tree } from '#tree';
import { planHash } from '#tree/plan-hash';
import { buildActor, executeStream, withExecute, type WithExecuteOpts } from './actions';

/** Higher-level dispatcher: tree + session + action input → result.
 *  Mods (e.g. harness/audit) inject this to add capability narrowing or other
 *  pre-execute logic. Without an executor, sessions go through plain executeAction. */
export type SessionExecutor = (
  tree: Tree,
  session: Session,
  input: { path: string; type?: string; key?: string; action: string; data?: unknown; opId?: string },
) => Promise<unknown>;

export type WireOpts = {
  /** TTL for cached claims in event connections (ms). Default 30s. 0 = no cache. */
  claimsTtlMs?: number;
  /** Dispatcher for workload-bound sessions (session.scopeRef set). Absent = fail closed. */
  executor?: SessionExecutor;
};

export type WireDeps = {
  tree: Tree;
  systemTree: Tree;
  watcher: WatchManager;
  opts?: WireOpts;
  /** Delegation wiring for Tree.execute (core-pxlu), built by createPipeline:
   *  authority probe (mounts) + local coherence reset + audit hooks. Absent =
   *  every action runs in the local executor. */
  exec?: Omit<WithExecuteOpts, 'identity'>;
};

export const DEFAULT_CLAIMS_TTL_MS = 30_000;

export type WireSession = ReturnType<typeof createWireSession>;

/** Plan equality for re-validate (F8-r3): canonical planHash + mountDeps. */
function samePlan(a: ResolvedReadPlan, b: ResolvedReadPlan): boolean {
  if (planHash(a.plan) !== planHash(b.plan)) return false;
  if (a.mountDeps.size !== b.mountDeps.size) return false;
  for (const dep of a.mountDeps) if (!b.mountDeps.has(dep)) return false;
  return true;
}

/** ls{watchList} registration (§3.2.3-3b): register the FROZEN plan, then
 *  re-resolve and compare (inv.23) — a mount-config flip between freeze and
 *  registration would leave a handle the config-event machinery can't find.
 *  Mismatch → undo + re-register (max 2 attempts, then CONFLICT with nothing
 *  registered). No frozen plan → legacy plain registration. Returns the
 *  committed lease + the plan it settled on (the read executes THAT, inv.21). */
export async function registerWatchList(
  watcher: WatchManager,
  tree: Pick<AclStore, 'planChildren'>,
  userId: string,
  path: string,
  itemWatch: boolean,
  token: string | undefined,
  planned?: ResolvedReadPlan,
): Promise<ListRegistration> {
  const register = (p?: ResolvedReadPlan) => watcher.watch(userId, [path], {
    children: true,
    autoWatch: itemWatch,
    // Query registration only for filtering plans — a bare listing is a plain prefix watch.
    ...(p && (p.plan.viewWhere || p.plan.callerWhere) ? { query: { plan: p.plan, mountDeps: p.mountDeps } } : {}),
    ...(token === undefined ? {} : { token }),
  });

  if (!planned) {
    return { undo: register().undo };
  }

  let active = planned;
  let lease = register(active);
  try {
    for (let attempt = 1; ; attempt++) {
      // Pure config read through the same pre-step the freeze used (invariant 21).
      const fresh = await tree.planChildren(path, { query: planned.plan.callerWhere, depth: planned.plan.depth });
      if (samePlan(fresh, active)) return { undo: lease.undo, plan: active };
      lease.undo();
      if (attempt === 2) {
        throw new OpError('CONFLICT', `read plan for ${path} kept changing during watch registration`);
      }
      active = fresh;
      lease = register(active);
    }
  } catch (e) {
    // F6/inv.15: a probe throw would escape with the lease live — the peer
    // hasn't received it yet, so its compensation can't help. undo() is
    // idempotent: already-undone paths (CONFLICT, register throw) are no-ops.
    lease.undo();
    throw e;
  }
}

/** NodeEvent → TWP event frames. VP membership/config deltas collapse into
 *  one `dirty` per affected view path (gk8.12 refetch semantics — precise
 *  add/rm cache surgery stays a tRPC-binding capability until cdcEval dies);
 *  `reconnect` becomes `reset` only when continuity was lost.
 *  seq/by come stamped from WatchManager delivery (core-gk8.1); dirty frames
 *  are facets of the same event and share its seq — the cursor is a
 *  watermark, clients track max(seen). Signal frames (dirty/reset) also carry
 *  the stream epoch (anz4.28e) — a dirty-only client must learn it. Data
 *  frames stay epoch-free (owner-approved additive surface §6). */
export function toEventFrames(e: StampedEvent | InvalidateEvent): EventFrame[] {
  // Frames must omit absent fields, not carry undefined: structured-clone
  // transports preserve undefined keys while JSON transports drop them —
  // explicit omission keeps the wire identical everywhere.
  const sig = {
    ...(e.seq === undefined ? {} : { seq: e.seq }),
    ...(e.epoch === undefined ? {} : { epoch: e.epoch }),
  };
  if (e.type === 'reconnect') {
    // A ring-routed break arrives stamped — the client adopts the post-break cursor (anz4.10/11).
    return e.preserved ? [] : [{ ev: 'reset', reason: 'resume', ...sig }];
  }
  // Pathless invalidate (core-dm1) → one dirty per view + per provenance-held
  // exact path (§3.4; recipient-scoped upstream, emission reveals nothing new).
  if (e.type === 'invalidate') {
    return [...e.vps, ...(e.paths ?? [])].map(p => ({ ...sig, ev: 'dirty', path: p }));
  }
  const meta = {
    ...(e.seq === undefined ? {} : { seq: e.seq }),
    ...(e.by === undefined ? {} : { by: e.by }),
  };
  const frames: EventFrame[] = [];
  if (e.type === 'set') frames.push({ ...meta, ev: 'set', path: e.path, node: e.node });
  else if (e.type === 'patch') {
    frames.push(e.rev === undefined
      ? { ...meta, ev: 'patch', path: e.path, ops: e.patches }
      : { ...meta, ev: 'patch', path: e.path, ops: e.patches, rev: e.rev });
  } else frames.push({ ...meta, ev: 'rm', path: e.path });

  for (const vp of e.invalidateVps ?? []) {
    frames.push({ ...sig, ev: 'dirty', path: vp });
  }
  return frames;
}

export function createWireSession(deps: WireDeps, session: Session) {
  const { userId } = session;

  // Claims + ACL tree are resolved per request — freshness parity with the
  // pre-TWP per-procedure middleware. Long-lived connections get the same
  // semantics as one HTTP request per frame.
  async function scope() {
    const claims = session.claims ?? await buildClaims(deps.systemTree, userId);
    const tree = withAcl(deps.tree, userId, claims);
    return { claims, tree };
  }

  async function serve(): Promise<PeerServe> {
    const { claims, tree } = await scope();

    // Workload sessions (scopeRef set) require a configured executor; fail
    // closed — a silent fallback would let a workload escape narrowing.
    const isWorkload = !!session.scopeRef;
    if (isWorkload && !deps.opts?.executor) {
      throw new OpError('FORBIDDEN', 'workload session present but no executor configured');
    }

    // `type` dropped on the promise path — parity with the pre-TWP dispatch
    // (both branches passed undefined); enabling component verification here
    // is a behavior change, decide separately. Stream path passes it (parity).
    // Actor is born once, at the request edge — every layer below (commit,
    // audit, cross-node writes) inherits it. Workload path: executor builds it.
    const actorFor = (req: ActReq) => buildActor(session, req.action, req.opId);

    const execute = (req: ActReq) => {
      if (isWorkload) return deps.opts!.executor!(tree, session, { ...req, type: undefined });
      // Tree.execute capability path (core-pxlu): the ACL tree is wrapped
      // per-request so identity (incl. the edge-born actor) binds at wrap time
      // — never via ExecOpts. Local paths run executeAction against the
      // wrapper (handlers' ctx.tree is exec-capable); foreign-authority paths
      // (deps.exec.delegate probe) are delegated to the remote side.
      const execTree = withExecute(tree, { ...deps.exec, identity: { userId, claims, actor: actorFor(req) } });
      return execTree.execute(req.path, req.action, req.data, { type: undefined, key: req.key, opId: req.opId });
    };

    const execStream = (req: ActReq, signal: AbortSignal) =>
      executeStream(tree, req.path, req.type, req.key, req.action, req.data, signal, { userId, claims, actor: actorFor(req) });

    // Opts (incl. the anz4.28 token) pass through — ServeHooks opts are a subset
    // of WatchOpts/UnwatchOpts. Leases return so the register-first peer can undo.
    const hooks: ServeHooks = {
      watch: (paths, o) => deps.watcher.watch(userId, paths, o),
      unwatch: (paths, o) => deps.watcher.unwatch(userId, paths, o),
      watchList: (path, itemWatch, token, plan) =>
        registerWatchList(deps.watcher, tree, userId, path, itemWatch, token, plan),
      holdPrefix: (path) => deps.watcher.holdPrefix(userId, path),
      armUnboundTtl: (token) => deps.watcher.armUnboundTtl(userId, token),
    };

    return { tree, execute, executeStream: execStream, hooks };
  }

  const peer = createPeer(serve);

  /** Event lane: ACL-filtered push wired into the WatchManager.
   *  `since` = client's last processed seq — the ring replays the gap
   *  through the SAME filter (claims drift re-applies, core-gk8.1).
   *  The verdict's {seq, epoch} is for the lane's INITIAL frame (anz4.28e). */
  function connectEvents(push: (e: WireEvent) => void, since?: number | WatchCursor, token?: string): { connId: string } & ConnectVerdict {
    const sessionClaims = session.claims?.length ? session.claims : null;
    const claimsTtlMs = deps.opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;
    const filtered = createFilteredPush(deps.systemTree, userId, sessionClaims, push, { claimsTtlMs });
    const connId = `${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const verdict = deps.watcher.connect(connId, userId, filtered, since, token);
    return { connId, ...verdict };
  }

  /** Event lane in TWP frames — native bindings (port/WS). An unpreserved
   *  verdict maps to a reset frame stamped with {seq, epoch} (anz4.28e), so it
   *  teaches the client a resumable cursor instead of looping through resets. */
  function connectEventFrames(emit: (f: EventFrame) => void, since?: number | WatchCursor, token?: string): { connId: string } {
    const { connId, preserved, seq, epoch } = connectEvents((e) => {
      for (const f of toEventFrames(e)) emit(f);
    }, since, token);
    if (!preserved) emit({ ev: 'reset', reason: 'resume', seq, epoch });
    return { connId };
  }

  return {
    session,
    /** Serve one frame (bindings call this; tRPC procedures delegate here). */
    handle: peer.handle,
    /** The symmetric peer — native bindings attach a Conn (core-nin.3). */
    peer,
    /** Claims + ACL tree for binding-level legacy ops (deployPrefab, setComponent, agentInitPair). */
    scope,
    connectEvents,
    connectEventFrames,
    disconnectEvents: (connId: string) => deps.watcher.disconnect(connId),
  };
}

/** Bind a wire session to a transport Conn — request serving + event lane.
 *  The postMessage host side is exactly this:
 *    attachWireSession(createWireSession(deps, session), createPortConn(port))
 *  Auth is ambient: the host constructs the session (spec §5.3) — no hi frame.
 *  Returns a teardown that detaches the peer and releases the event connection. */
export function attachWireSession(session: WireSession, conn: Conn, since?: number | WatchCursor, token?: string): () => void {
  const detach = session.peer.attach(conn);
  const { connId } = session.connectEventFrames((f) => session.peer.emit(f), since, token);
  return () => {
    session.disconnectEvents(connId);
    detach();
  };
}
