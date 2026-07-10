// TWP server session — the transport-agnostic serving side (docs/research/twp-spec.md §8).
// The ONE place where ACL/claims/watch/CDC wiring meets the protocol: every
// binding (tRPC today; postMessage/WS/HTTP next, core-nin.3+) wraps this.
// Extracted from the tRPC withSession middleware + events subscription body.

import { OpError } from '#errors';
import { randomUUID } from 'node:crypto';
import type { EventFrame } from '#protocol/frames';
import { createPeer, type ActReq, type Conn, type PeerServe, type ServeHooks } from '#protocol/peer';
import { withAcl } from '#security/acl-tree';
import { buildClaims } from '#security/claims';
import { getPageReadPlan } from '#security/read-page';
import type { Session } from '#security/sessions';
import { type NodeEvent, type WireEvent } from '#sub';
import { type WatchManager } from '#sub/watch';
import { createFilteredPush } from '#sub/watch-filter';
import type { Tree } from '#tree';
import { executeStream, withExecute, type WithExecuteOpts } from './actions';

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

/** NodeEvent → TWP event frames. VP membership/config deltas collapse into
 *  one `dirty` per affected view path (gk8.12 refetch semantics — precise
 *  add/rm cache surgery stays a tRPC-binding capability until cdcEval dies);
 *  `reconnect` becomes `reset` only when continuity was lost.
 *  seq/by come stamped from WatchManager delivery (core-gk8.1); dirty frames
 *  are facets of the same event and share its seq — the cursor is a
 *  watermark, clients track max(seen). */
export function toEventFrames(e: WireEvent): EventFrame[] {
  if (e.type === 'reconnect') {
    return e.preserved ? [] : [{ ev: 'reset', reason: 'resume' }];
  }
  // Pathless invalidate (core-dm1) → one dirty frame per view, no data facet.
  if (e.type === 'invalidate') {
    return e.vps.map(vp => ({ ...(e.seq === undefined ? {} : { seq: e.seq }), ev: 'dirty', path: vp }));
  }
  // Frames must omit absent fields, not carry undefined: structured-clone
  // transports preserve undefined keys while JSON transports drop them —
  // explicit omission keeps the wire identical everywhere.
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
    frames.push({ ...(e.seq === undefined ? {} : { seq: e.seq }), ev: 'dirty', path: vp });
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
    const actorFor = (req: ActReq) => ({ id: userId, action: req.action, requestId: req.opId ?? randomUUID() });

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

    const hooks: ServeHooks = {
      watch: (paths, o) => deps.watcher.watch(userId, paths, o),
      unwatch: (paths, o) => deps.watcher.unwatch(userId, paths, o),
      watchList: (path, page, itemWatch) => {
        const query = getPageReadPlan(page);
        deps.watcher.watch(userId, [path], { children: true, autoWatch: itemWatch, query });
      },
    };

    return { tree, execute, executeStream: execStream, hooks };
  }

  const peer = createPeer(serve);

  /** Event lane: ACL-filtered push wired into the WatchManager.
   *  `since` = client's last processed seq — the ring replays the gap
   *  through the SAME filter (claims drift re-applies, core-gk8.1). */
  function connectEvents(push: (e: WireEvent) => void, since?: number): { connId: string; preserved: boolean } {
    const sessionClaims = session.claims?.length ? session.claims : null;
    const claimsTtlMs = deps.opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;
    const filtered = createFilteredPush(deps.systemTree, userId, sessionClaims, push, { claimsTtlMs });
    const connId = `${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const preserved = deps.watcher.connect(connId, userId, filtered, since);
    return { connId, preserved };
  }

  /** Event lane in TWP frames — native bindings (port/WS). The initial
   *  continuity verdict maps to a reset frame when watches were not preserved. */
  function connectEventFrames(emit: (f: EventFrame) => void, since?: number): { connId: string } {
    const { connId, preserved } = connectEvents((e) => {
      for (const f of toEventFrames(e)) emit(f);
    }, since);
    if (!preserved) emit({ ev: 'reset', reason: 'resume' });
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
export function attachWireSession(session: WireSession, conn: Conn, since?: number): () => void {
  const detach = session.peer.attach(conn);
  const { connId } = session.connectEventFrames((f) => session.peer.emit(f), since);
  return () => {
    session.disconnectEvents(connId);
    detach();
  };
}
