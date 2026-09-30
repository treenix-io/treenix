// TWP peer — symmetric protocol core (docs/research/twp-spec.md §5, §8).
// One module serves both ends of a connection: a dispatcher over the LOCAL
// tree (fail closed: no serve config = every request FORBIDDEN) plus the
// requester core (id allocation, pending map, stream adaptation, cancel).
// Transports stay dumb — they only move frames (Conn contract).

import { isRef, type NodeData, R, S } from '#core';
import { assertSafePath } from '#core/path';
import { KernelError } from '#errors';
import { followMoved, type ChildrenOpts, type Page, type Tree } from '#tree';
import type { ResolvedReadPlan } from '#mount/resolve-plan';
import type { PatchOp } from '#tree/patch';
import { subscriptionToAsyncIterable } from '#tree/watch';
import {
  isByeFrame, isCancelFrame, isEventFrame, isHiFrame, isPingFrame, isPongFrame,
  isReqFrame, isResFrame,
  type ActFrame, type ErrFrame, type EventFrame, type Frame, type LsFrame,
  type OkFrame, type ReqFrame, type ResFrame, type SubFrame, type UnsubFrame,
} from './frames';

/** Ordered, reliable, duplex channel of structured frames (spec §4).
 *  Incoming frames are untrusted — the peer narrows and validates. */
export type Conn = {
  send(frame: Frame): void;
  onFrame(cb: (frame: unknown) => void): () => void;
  /** Reconnecting transports report link state; resume logic lives above (core-nin.2). */
  onState?(cb: (s: 'up' | 'down') => void): () => void;
  close(): void;
};

export type ActReq = { path: string; type?: string; key?: string; action: string; data?: unknown; opId?: string };
export type ActionDispatch = (req: ActReq) => Promise<unknown>;
export type ActionStream = (req: ActReq, signal: AbortSignal) => AsyncIterable<unknown>;

/** Compensation handle of one registration (inv.15): undo drops exactly the holds that call created. */
export type WatchUndo = { undo(): void };

/** watchList hook result (slice 4): the committed lease + the plan the
 *  registration SETTLED on (inv.23) — the read must execute THAT plan, not
 *  the pre-validate freeze (inv.21 parity by construction). */
export type ListRegistration = WatchUndo & { plan?: ResolvedReadPlan };

// `token` = watch-ownership scope of the requesting consumer (core-anz4.28):
// threaded from the frame so registration and release land on the same holder.
export type ServeHooks = {
  /** Returns the lease when the backing manager leases — register-first verbs undo it on read failure. */
  watch(paths: string[], opts?: { children?: boolean; autoWatch?: boolean; token?: string }): WatchUndo | void;
  unwatch(paths: string[], opts?: { children?: boolean; token?: string }): void;
  /** ls{watchList}: register BEFORE the read (slice 4, closes W2); `plan` is
   *  the frozen plan (inv.21). Awaited — a registration failure (re-validate
   *  CONFLICT, inv.23) must fail the request, not race past it. */
  watchList?(path: string, itemWatch: boolean, token?: string, plan?: ResolvedReadPlan): void | ListRegistration | Promise<void | ListRegistration>;
  /** Request-scoped provisional prefix (inv.27): unique per-request holder; returns the release. */
  holdPrefix?(path: string): () => void;
  /** Bracket-open of one tokened request (inv.25 F3): pairs with the
   *  armUnboundTtl call in the peer's finally so the TTL arms only when the
   *  LAST overlapping same-token request completes. */
  beginTokenRequest?(token: string): void;
  /** Unbound-token TTL arm (inv.25/F7): the peer calls it when a tokened
   *  request completes — the countdown must not start mid-read. */
  armUnboundTtl?(token: string): void;
};

/** Core waist + the ACL-layer capabilities the protocol exploits when present
 *  (getPerm S/R gates; frozen-plan pre-step §3.2). Structural on purpose:
 *  peers can serve bare adapters (no gates ⇒ watch ops fail closed). */
export type ServeTree = Tree & {
  getPerm?(path: string): Promise<number>;
  planChildren?(path: string, opts?: Pick<ChildrenOpts, 'query' | 'depth'>, ctx?: unknown): Promise<ResolvedReadPlan>;
  getChildren(path: string, opts?: ChildrenOpts & { plan?: ResolvedReadPlan }, ctx?: unknown): Promise<Page<NodeData>>;
};

export type PeerServe = {
  tree: ServeTree;
  execute?: ActionDispatch;
  executeStream?: ActionStream;
  hooks?: ServeHooks;
  /** Emitter seq watermark for ok.at — wired by the server session (gk8.1). */
  at?(): number;
};

/** Resolved per request so claims/ACL freshness matches today's per-request
 *  tRPC middleware. Cheap factories return a constant. */
export type ServeFactory = () => PeerServe | Promise<PeerServe>;

export type Peer = ReturnType<typeof createPeer>;

const MAX_WATCH_FROM_RESULT = 100;
const DEFAULT_LS_LIMIT = 100;

// Strict by contract: when result IS a list (`items` array), every item must
// be a node-shape with string `$path`. The action-watch path consumes this —
// silently dropping malformed items would mask handler bugs and let a partial
// watch set look like the full one. Non-node results (scalar, `{count}`,
// undefined) return `[]` explicitly — that's "nothing to watch", not a
// malformed shape. (Moved from tree/volatile.ts with the $volatile cut.)
export function extractPaths(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.items)) {
    const items = r.items;
    const paths: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      if (!n || typeof n !== 'object' || typeof (n as { $path?: unknown }).$path !== 'string') {
        throw new KernelError('INVALID', `extractPaths: items[${i}] missing string $path`);
      }
      paths.push((n as { $path: string }).$path);
    }
    return paths;
  }
  if (typeof r.$path === 'string') return [r.$path];
  return [];
}

function isAsyncIterable(v: unknown): v is AsyncIterable<ResFrame> {
  return typeof v === 'object' && v !== null && Symbol.asyncIterator in v;
}

function vPath(p: unknown): string {
  if (typeof p !== 'string') throw new KernelError('INVALID', 'path must be a string');
  // assertSafePath throws plain Error — wire-facing paths map to INVALID
  // (the act result-path assert below stays loud-INTERNAL: handler bug, not caller's).
  try { assertSafePath(p); }
  catch (e) { throw new KernelError('INVALID', e instanceof Error ? e.message : String(e)); }
  return p;
}

function vPaths(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new KernelError('INVALID', 'paths must be an array');
  return v.map(vPath);
}

// Wire tokens are untrusted. Empty would silently alias the internal LEGACY
// hold; \0 is the provisional namespace (inv.27) — a guessed holder id could
// strip an in-flight request's window coverage. Reject both loudly.
function vToken(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > 256 || v.includes('\0')) {
    throw new KernelError('INVALID', 'token must be a non-empty string (max 256)');
  }
  return v;
}

// A failure outside the error vocabulary is a server bug: its message may name internals (paths, queries, stack
// detail), and any caller, anonymous included, reads the frame, so the detail stays in the server log.
function toErrFrame(id: number, e: unknown): ErrFrame {
  if (e instanceof KernelError) return { id, err: { code: e.code, msg: e.message } };
  console.error('[twp] handler error:', e);
  return { id, err: { code: 'INTERNAL', msg: 'internal error' } };
}

function cancelledFrame(id: number): ErrFrame {
  return { id, err: { code: 'CANCELLED', msg: 'twp: request cancelled' } };
}

function toError(err: ErrFrame['err']): Error {
  return err.code === 'INTERNAL' ? new Error(err.msg) : new KernelError(err.code, err.msg);
}

/** Write ctx carrying the client mutation id — events echo it as `by` (gk8.1). */
function writeCtx(opId: string | undefined): { opId: string } | undefined {
  return opId ? { opId } : undefined;
}

// Register-first compensation (§3.2.5): rolls back exactly this request's own
// registrations. Undo failure logs loudly and never masks the request's error —
// the orphan dies by token-TTL/grace (accepted residual §8). Double-undo safe.
function undoHolds(...holds: (WatchUndo | (() => void) | void | undefined)[]) {
  for (const h of holds) {
    if (!h) continue;
    try {
      if (typeof h === 'function') h();
      else h.undo();
    } catch (e) {
      console.error('[twp] watch compensation failed:', e);
    }
  }
}

export function createPeer(serve?: ServeFactory) {
  let nextId = 1;
  let conn: Conn | null = null;
  let offFrame: (() => void) | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const streams = new Map<number, { push: (f: ResFrame) => void; end: () => void }>();
  const inflight = new Map<number, AbortController>();
  const eventCbs = new Set<(e: EventFrame) => void>();

  // ── serving side ──

  // Token is injected HERE so no registration/release site can forget it —
  // a missed site would land the hold on the shared LEGACY holder (anz4.28).
  function watchCaps(s: PeerServe, token: string | undefined) {
    const getPerm = s.tree.getPerm?.bind(s.tree);
    const hooks = s.hooks;
    if (!getPerm || !hooks) throw new KernelError('INVALID', 'watch unsupported by this peer');
    return {
      getPerm,
      watch: (paths: string[], opts?: { children?: boolean; autoWatch?: boolean }) =>
        hooks.watch(paths, { ...opts, token }),
      unwatch: (paths: string[], opts?: { children?: boolean }) =>
        hooks.unwatch(paths, { ...opts, token }),
    };
  }

  async function resolveServe(): Promise<PeerServe> {
    if (!serve) throw new KernelError('FORBIDDEN', 'peer does not serve (no export policy)');
    return serve();
  }

  function handle(frame: ReqFrame, ctx?: unknown): Promise<ResFrame> | AsyncIterable<ResFrame> {
    if (frame.op === 'act' && frame.stream) return handleActStream(frame);
    return handleUnary(frame, ctx);
  }

  async function handleUnary(frame: ReqFrame, ctx?: unknown): Promise<ResFrame> {
    let served: PeerServe | undefined;
    // Raw (pre-vToken) on purpose: the finally arms with the same raw value,
    // so begin/arm pair exactly even for requests that fail validation.
    const reqToken = 'token' in frame && typeof frame.token === 'string' && frame.token.length > 0
      ? frame.token : undefined;
    try {
      const s = served = await resolveServe();
      // F3/inv.25: open the request bracket only when the boundary arm exists
      // too — an unpaired begin would leave the in-flight count high forever
      // and the TTL would never arm.
      if (reqToken !== undefined && s.hooks?.armUnboundTtl && s.hooks.beginTokenRequest) {
        try { s.hooks.beginTokenRequest(reqToken); }
        catch (e) { console.error('[twp] token request bracket failed:', e); }
      }
      const ok = (v: unknown): OkFrame => (s.at ? { id: frame.id, ok: v, at: s.at() } : { id: frame.id, ok: v });

      switch (frame.op) {
        case 'get': {
          const path = vPath(frame.path);
          // Validated on presence — a malformed token is a protocol error even without watch.
          const token = vToken(frame.token);
          const cap = frame.watch ? watchCaps(s, token) : undefined;
          // Register-first (§3.2, closes W-get): a write landing mid-read is already routed to the lane.
          let lease: WatchUndo | undefined;
          if (cap && ((await cap.getPerm(path)) & S)) lease = cap.watch([path]) ?? undefined;
          let node: NodeData | undefined;
          try {
            node = await s.tree.get(path);
          } catch (e) {
            undoHolds(lease);
            throw e;
          }
          // Pre-slice-4 contract pinned: an absent path holds no watch.
          if (!node) undoHolds(lease);
          return ok(node);
        }

        case 'resolve': {
          const path = vPath(frame.path);
          const token = vToken(frame.token);
          const cap = frame.watch ? watchCaps(s, token) : undefined;
          // Register-first (§3.2.7): each watch precedes the read it covers;
          // any failure undoes every hold THIS request created.
          const leases: WatchUndo[] = [];
          try {
            if (cap && ((await cap.getPerm(path)) & S)) {
              const l = cap.watch([path]);
              if (l) leases.push(l);
            }
            const node = await s.tree.get(path);
            if (!node) {
              undoHolds(...leases); // absent path holds no watch (contract pin)
              return ok([]);
            }
            const result: NodeData[] = [node];
            if (isRef(node)) {
              // Follow 'moved' tombstone chains so the client gets the LIVE
              // node, not the tombstone (gk8.10 stage 2). Best-effort by
              // contract: missing target or a broken chain (identity mismatch,
              // hop limit) degrades to [node] — the wire op is not a validator.
              // No self-repair here: this user's surface may be read-only;
              // repair belongs to server-side resolveRef callers.
              let target: NodeData | undefined;
              try {
                ({ target } = await followMoved(s.tree, node.$ref, node.$refId));
              } catch (e) {
                if (!(e instanceof KernelError)) throw e;
                console.error(`[twp] resolve: broken ref chain from ${node.$ref}:`, e);
              }
              if (target && cap && ((await cap.getPerm(target.$path)) & S)) {
                const tl = cap.watch([target.$path]) ?? undefined;
                if (tl) leases.push(tl);
                // Re-get closes the target window (§3.2.7): respond with the
                // post-registration image; vanished → degrade to [node], no watch.
                const fresh = await s.tree.get(target.$path);
                if (fresh) result.push(fresh);
                else undoHolds(tl);
              } else if (target) {
                result.push(target);
              }
            }
            return ok(result);
          } catch (e) {
            undoHolds(...leases);
            throw e;
          }
        }

        case 'ls': {
          const path = vPath(frame.path);
          if (frame.query !== undefined) {
            if (typeof frame.query !== 'object' || frame.query === null || Array.isArray(frame.query)) {
              throw new KernelError('INVALID', 'ls.query must be an object');
            }
            // Query-watch membership eval fires for DIRECT children of the
            // source only — a deep query watch would silently miss deeper
            // flips. Reject rather than half-work (watch stays depth-1, MVP).
            if (frame.watch && frame.depth !== undefined && frame.depth !== 1) {
              throw new KernelError('INVALID', 'query watch is depth-1 only');
            }
          }
          // List-watch notify is direct-parent-only (sub/watch.ts) regardless of
          // query: a deep ls+watchList would read grandchildren then silently
          // miss their changes (core-karx). Exact-path item watches (frame.watch
          // without query) work at any depth and stay allowed.
          if (frame.watchList && frame.depth !== undefined && frame.depth !== 1) {
            throw new KernelError('INVALID', 'watchList is depth-1 only');
          }
          if (frame.cursor !== undefined && typeof frame.cursor !== 'string') {
            throw new KernelError('INVALID', 'ls.cursor must be a string');
          }
          const token = vToken(frame.token);
          const cap = frame.watch ? watchCaps(s, token) : undefined;
          const watchList = frame.watchList ? s.hooks?.watchList?.bind(s.hooks) : undefined;
          if (frame.watchList && !watchList) throw new KernelError('INVALID', 'watchList unsupported by this peer');
          let frozen: ResolvedReadPlan | undefined;
          let listReg: ListRegistration | undefined;
          if (watchList) {
            // S-gate on the PARENT (inv.22), same permission as the sub prefix
            // gate. Fail closed: no perm surface = INVALID, no S = FORBIDDEN.
            const getPerm = s.tree.getPerm?.bind(s.tree);
            if (!getPerm) throw new KernelError('INVALID', 'watchList unsupported by this peer');
            if (!((await getPerm(path)) & S)) throw new KernelError('FORBIDDEN', `watchList denied: ${path}`);
            // Freeze the plan ONCE (inv.21): registration takes it, the read executes what it settles on.
            frozen = await s.tree.planChildren?.(path, { query: frame.query, depth: frame.depth }, ctx);
            // Register BEFORE the read (§3.2, closes W2): a membership flip
            // mid-scan is routed to the lane; the client's overlap machinery reconciles.
            listReg = (await watchList(path, !!frame.watch, token, frozen)) ?? undefined;
            // inv.23: read what the registration settled on — parity by construction.
            if (listReg?.plan) frozen = listReg.plan;
          }
          // Provisional request-scoped prefix (inv.27): covers the [scan →
          // item-watch] window of watch-without-watchList. Gated on parent-S
          // and depth-1; no-S and deep ls stay documented residuals (§3.5).
          let provisional: (() => void) | undefined;
          if (cap && !watchList && s.hooks?.holdPrefix
            && (frame.depth === undefined || frame.depth === 1)
            && ((await cap.getPerm(path)) & S)) {
            provisional = s.hooks.holdPrefix(path);
          }
          let page: Page<NodeData>;
          try {
            // ctx threaded to getChildren only — parity with the pre-TWP router;
            // uniform threading to all tree calls is a separate decision.
            page = await s.tree.getChildren(
              path,
              { limit: frame.limit ?? DEFAULT_LS_LIMIT, depth: frame.depth, query: frame.query, cursor: frame.cursor, ...(frozen ? { plan: frozen } : {}) },
              ctx,
            );
            if (cap) {
              const watchable: string[] = [];
              for (const n of page.items) if ((await cap.getPerm(n.$path)) & S) watchable.push(n.$path);
              if (watchable.length) cap.watch(watchable);
            }
          } catch (e) {
            undoHolds(listReg);
            throw e;
          } finally {
            // Released only AFTER item watches stand (or the request failed):
            // events during the window already reached the lane.
            undoHolds(provisional);
          }
          return ok(page);
        }

        case 'set': {
          const path = vPath(frame.path);
          if (typeof frame.node !== 'object' || frame.node === null) throw new KernelError('INVALID', 'node must be an object');
          if (typeof frame.node.$type !== 'string') throw new KernelError('INVALID', 'node.$type required');
          // path field is authoritative; wire payload never carries $path/$patches (spec §6).
          // $id is the node's OWN server-minted identity (bd core-anz4.2): a client-supplied $id
          // on a fresh path would store a foreign ULID verbatim — strip; policy re-echoes/mints.
          // $refId stays: it's the ref TARGET's identity, client-editable with $ref and
          // load-bearing for id-first ref resolution — stripping it downgrades to path-only.
          const { $path: _wirePath, $patches: _patches, $id: _id, ...clean } = frame.node;
          await s.tree.set({ ...clean, $type: frame.node.$type, $path: path }, writeCtx(frame.opId));
          return ok(undefined);
        }

        case 'patch': {
          const path = vPath(frame.path);
          if (!Array.isArray(frame.ops)) throw new KernelError('INVALID', 'ops must be an array');
          await s.tree.patch(path, frame.ops, writeCtx(frame.opId));
          return ok(undefined);
        }

        case 'rm': {
          const path = vPath(frame.path);
          // Wire ack stays boolean (core-ns6p.2 keeps the protocol frozen).
          // Opaque receipt (path behind a remote authority) maps to true —
          // parity with the pre-receipt transport, which reported forwarded
          // removes as removed.
          const receipt = await s.tree.remove(path, writeCtx(frame.opId));
          return ok(receipt.changes === null ? true : receipt.changes.length > 0);
        }

        case 'act': {
          const path = vPath(frame.path);
          if (typeof frame.action !== 'string' || !frame.action) throw new KernelError('INVALID', 'action must be a string');
          if (!s.execute) throw new KernelError('INVALID', 'peer does not execute actions');
          const token = vToken(frame.token);
          const cap = frame.watch ? watchCaps(s, token) : undefined;
          const result = await s.execute({
            path, type: frame.type, key: frame.key, action: frame.action, data: frame.data, opId: frame.opId,
          });
          if (cap) {
            // R4-MOUNT-5: result paths are handler-controlled — assert shape,
            // cap the count, and R-filter (silent-drop forbidden ones mirrors filter-on-emit).
            const candidates = extractPaths(result).slice(0, MAX_WATCH_FROM_RESULT);
            const allowed: string[] = [];
            for (const p of candidates) {
              assertSafePath(p);
              if ((await cap.getPerm(p)) & R) allowed.push(p);
            }
            if (allowed.length) cap.watch(allowed);
          }
          return ok(result);
        }

        case 'perm': {
          const path = vPath(frame.path);
          const getPerm = s.tree.getPerm;
          if (!getPerm) throw new KernelError('INVALID', 'perm unsupported by this peer');
          return ok(await getPerm.call(s.tree, path));
        }

        case 'sub': {
          const cap = watchCaps(s, vToken(frame.token));
          // S-gate; non-S paths silently dropped — same ACL trust-boundary rule as ls.watch.
          const paths: string[] = [];
          for (const p of vPaths(frame.paths)) if ((await cap.getPerm(p)) & S) paths.push(p);
          if (paths.length) cap.watch(paths);
          const prefixes: string[] = [];
          for (const p of vPaths(frame.prefixes)) if ((await cap.getPerm(p)) & S) prefixes.push(p);
          if (prefixes.length) cap.watch(prefixes, { children: true });
          return ok(undefined);
        }

        case 'unsub': {
          const cap = watchCaps(s, vToken(frame.token));
          const paths = vPaths(frame.paths);
          if (paths.length) cap.unwatch(paths);
          const prefixes = vPaths(frame.prefixes);
          if (prefixes.length) cap.unwatch(prefixes, { children: true });
          return ok(undefined);
        }
      }
      // isReqFrame admitted the op set above — reaching here is a routing bug.
      throw new KernelError('INVALID', 'unknown op');
    } catch (e) {
      return toErrFrame(frame.id, e);
    } finally {
      // inv.25/F7: start the unbound-token TTL countdown only once the request
      // is DONE — a mid-read expiry would strip coverage the response still
      // relies on. Closes the F3 bracket: the manager decrements the in-flight
      // count and arms only at zero (and only if the token registered lanelessly).
      if (served?.hooks?.armUnboundTtl && reqToken !== undefined) {
        try { served.hooks.armUnboundTtl(reqToken); }
        catch (e) { console.error('[twp] unbound-token TTL arm failed:', e); }
      }
    }
  }

  async function* handleActStream(frame: ActFrame): AsyncIterable<ResFrame> {
    let s: PeerServe;
    let req: ActReq;
    try {
      s = await resolveServe();
      if (!s.executeStream) throw new KernelError('INVALID', 'peer does not stream actions');
      const path = vPath(frame.path);
      if (typeof frame.action !== 'string' || !frame.action) throw new KernelError('INVALID', 'action must be a string');
      req = { path, type: frame.type, key: frame.key, action: frame.action, data: frame.data, opId: frame.opId };
    } catch (e) {
      yield toErrFrame(frame.id, e);
      return;
    }

    const ac = new AbortController();
    inflight.set(frame.id, ac);
    try {
      // Starvation hazard: a handler that loops on microtasks only (no IO/timer
      // awaits between yields) can starve macrotask transports (postMessage,
      // ws) so the cancel frame never lands. Handlers must hit the event loop;
      // protocol-level chunk credits are deferred (twp-spec §11.4).
      for await (const item of s.executeStream(req, ac.signal)) {
        if (ac.signal.aborted) break;
        yield { id: frame.id, ch: item };
      }
      // A handler that honours the signal returns early — the stream still ended by cancel, not by completion.
      yield ac.signal.aborted ? cancelledFrame(frame.id) : { id: frame.id, end: true };
    } catch (e) {
      yield ac.signal.aborted ? cancelledFrame(frame.id) : toErrFrame(frame.id, e);
    } finally {
      // Consumer teardown (iterator.return) must abort the handler's signal too.
      ac.abort();
      inflight.delete(frame.id);
    }
  }

  // ── requester side ──

  function call(build: (id: number) => ReqFrame): Promise<unknown> {
    const c = conn;
    if (!c) return Promise.reject(new KernelError('UNAVAILABLE', 'twp: peer not attached'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      c.send(build(id));
    });
  }

  function callStream(build: (id: number) => ReqFrame): AsyncIterable<unknown> {
    const id = nextId++;
    const frames = subscriptionToAsyncIterable<ResFrame>(
      (push, endStream) => {
        const c = conn;
        if (!c) {
          push({ id, err: { code: 'UNAVAILABLE', msg: 'twp: peer not attached' } });
          endStream();
          return () => {};
        }
        streams.set(id, { push, end: endStream });
        c.send(build(id));
        return () => {
          if (streams.delete(id)) conn?.send({ op: 'cancel', id });
        };
      },
      { id, err: { code: 'BUDGET', msg: 'twp: stream overflow' } },
    );

    return (async function* () {
      for await (const f of frames) {
        if ('ch' in f) yield f.ch;
        else if ('err' in f) throw toError(f.err);
        else if ('end' in f) return;
      }
    })();
  }

  // ── frame routing ──

  async function route(raw: unknown): Promise<void> {
    if (isResFrame(raw)) {
      const p = pending.get(raw.id);
      if (p) {
        pending.delete(raw.id);
        if ('ok' in raw) p.resolve(raw.ok);
        else if ('err' in raw) p.reject(toError(raw.err));
        else p.reject(new Error('twp: stream frame for unary request'));
        return;
      }
      const st = streams.get(raw.id);
      if (st) {
        st.push(raw);
        if ('end' in raw || 'err' in raw) {
          streams.delete(raw.id);
          st.end();
        }
        return;
      }
      return; // late frames after local cancel are protocol-normal — drop
    }

    if (isEventFrame(raw)) {
      for (const cb of eventCbs) {
        try { cb(raw); }
        catch (e) { console.error('[twp] event callback error:', e); }
      }
      return;
    }

    if (isCancelFrame(raw)) {
      inflight.get(raw.id)?.abort();
      return;
    }

    if (isReqFrame(raw)) {
      const r = handle(raw);
      if (isAsyncIterable(r)) {
        for await (const f of r) {
          if (!conn) break;
          conn.send(f);
        }
      } else {
        const f = await r;
        conn?.send(f);
      }
      return;
    }

    if (isPingFrame(raw)) { conn?.send({ op: 'pong' }); return; }
    if (isPongFrame(raw)) return;
    if (isByeFrame(raw)) { failAll(new Error('twp: remote closed')); return; }
    if (isHiFrame(raw)) { console.error('[twp] hi frame reached bare peer — handshake is binding-level (core-nin.3)'); return; }
    console.error('[twp] unroutable frame:', raw);
  }

  function failAll(e: Error) {
    for (const [, p] of pending) p.reject(e);
    pending.clear();
    for (const [, st] of streams) st.end();
    streams.clear();
    for (const [, ac] of inflight) ac.abort();
    inflight.clear();
  }

  function detach() {
    offFrame?.();
    offFrame = null;
    conn = null;
    failAll(new Error('twp: connection closed'));
  }

  return {
    /** Serve one frame directly (in-process bindings, e.g. the tRPC router). */
    handle,

    attach(c: Conn): () => void {
      if (conn) throw new Error('twp: peer already attached');
      conn = c;
      offFrame = c.onFrame((raw) => {
        route(raw).catch((e) => console.error('[twp] route error:', e));
      });
      return detach;
    },

    close() {
      const c = conn;
      detach();
      c?.close();
    },

    onEvent(cb: (e: EventFrame) => void): () => void {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },

    /** Push a local event to the remote peer (server event lane). */
    emit(e: EventFrame): void {
      if (!conn) { console.error('[twp] emit without connection'); return; }
      conn.send(e);
    },

    req: {
      get: (path: string, watch?: boolean, token?: string) => call((id) => ({ id, op: 'get', path, watch, token })),
      resolve: (path: string, watch?: boolean, token?: string) => call((id) => ({ id, op: 'resolve', path, watch, token })),
      ls: (path: string, o?: Omit<LsFrame, 'id' | 'op' | 'path'>) => call((id) => ({ id, op: 'ls', path, ...o })),
      set: (path: string, node: Record<string, unknown>, opId?: string) => call((id) => ({ id, op: 'set', path, node, opId })),
      patch: (path: string, ops: PatchOp[], opId?: string) => call((id) => ({ id, op: 'patch', path, ops, opId })),
      rm: (path: string, opId?: string) => call((id) => ({ id, op: 'rm', path, opId })),
      act: (a: ActReq & { watch?: boolean; token?: string }) => call((id) => ({ id, op: 'act', ...a })),
      actStream: (a: ActReq) => callStream((id) => ({ id, op: 'act', stream: true, ...a })),
      perm: (path: string) => call((id) => ({ id, op: 'perm', path })),
      sub: (o: Omit<SubFrame, 'id' | 'op'>) => call((id) => ({ id, op: 'sub', ...o })),
      unsub: (o: Omit<UnsubFrame, 'id' | 'op'>) => call((id) => ({ id, op: 'unsub', ...o })),
    },
  };
}
