// TWP server session — the transport-agnostic serving side (docs/research/twp-spec.md §8).
// The ONE place where ACL/claims/watch/CDC wiring meets the protocol: every
// binding (tRPC today; postMessage/WS/HTTP next, core-nin.3+) wraps this.
// Extracted from the tRPC withSession middleware + events subscription body.

import { OpError } from '#errors';
import { createPeer, type ActReq, type PeerServe, type ServeHooks } from '#protocol/peer';
import { buildClaims, type Session, withAcl } from '#security/auth';
import { type CdcRegistry, type NodeEvent } from '#sub';
import { type WatchManager } from '#sub/watch';
import { createFilteredPush } from '#sub/watch-filter';
import type { Tree } from '#tree';
import { executeAction, executeStream } from './actions';

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
  cdc?: CdcRegistry;
  opts?: WireOpts;
};

export const DEFAULT_CLAIMS_TTL_MS = 30_000;

export type WireSession = ReturnType<typeof createWireSession>;

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
    const execute = (req: ActReq) =>
      isWorkload
        ? deps.opts!.executor!(tree, session, { ...req, type: undefined })
        : executeAction(tree, req.path, undefined, req.key, req.action, req.data, { userId, claims, opId: req.opId });

    const execStream = (req: ActReq, signal: AbortSignal) =>
      executeStream(tree, req.path, req.type, req.key, req.action, req.data, signal, { userId, claims });

    const hooks: ServeHooks = {
      watch: (paths, o) => deps.watcher.watch(userId, paths, o),
      unwatch: (paths, o) => {
        deps.watcher.unwatch(userId, paths, o);
        if (o?.children) for (const p of paths) deps.cdc?.unwatchQuery(p, userId);
      },
      watchList: (path, page, itemWatch) => {
        if (page.queryMount) {
          deps.cdc?.watchQuery(path, page.queryMount.source, page.queryMount.match, userId, session.claims ?? null);
        }
        deps.watcher.watch(userId, [path], { children: true, autoWatch: itemWatch });
      },
    };

    return { tree, execute, executeStream: execStream, hooks };
  }

  const peer = createPeer(serve);

  /** Event lane: ACL-filtered push wired into the WatchManager.
   *  Returns reconnect verdict — exactly the pre-TWP `events` subscription body. */
  function connectEvents(push: (e: NodeEvent) => void): { connId: string; preserved: boolean } {
    const sessionClaims = session.claims?.length ? session.claims : null;
    const claimsTtlMs = deps.opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;
    const filtered = createFilteredPush(deps.systemTree, userId, sessionClaims, push, { claimsTtlMs });
    const connId = `${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const preserved = deps.watcher.connect(connId, userId, filtered);
    return { connId, preserved };
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
    disconnectEvents: (connId: string) => deps.watcher.disconnect(connId),
  };
}
