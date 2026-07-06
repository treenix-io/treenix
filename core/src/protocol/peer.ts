// TWP peer — symmetric protocol core (docs/research/twp-spec.md §5, §8).
// One module serves both ends of a connection: a dispatcher over the LOCAL
// tree (fail closed: no serve config = every request FORBIDDEN) plus the
// requester core (id allocation, pending map, stream adaptation, cancel).
// Transports stay dumb — they only move frames (Conn contract).

import { isRef, type NodeData, R, S } from '#core';
import { assertSafePath } from '#core/path';
import { OpError } from '#errors';
import type { Page, Tree } from '#tree';
import type { PatchOp } from '#tree/patch';
import { subscriptionToAsyncIterable } from '#tree/watch';
import {
  isByeFrame, isCancelFrame, isEventFrame, isHiFrame, isPingFrame, isPongFrame,
  isReqFrame, isResFrame,
  type ActFrame, type ErrFrame, type EventFrame, type Frame, type LsFrame,
  type OkFrame, type ReqFrame, type ResFrame,
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

export type ServeHooks = {
  watch(paths: string[], opts?: { children?: boolean; autoWatch?: boolean }): void;
  unwatch(paths: string[], opts?: { children?: boolean }): void;
  /** ls{watchList}: receives the RAW page (incl. queryMount) before it is stripped from the response. */
  watchList?(path: string, page: Page<NodeData>, itemWatch: boolean): void;
};

export type PeerServe = {
  tree: Tree & { getPerm?(path: string): Promise<number> };
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
        throw new OpError('BAD_REQUEST', `extractPaths: items[${i}] missing string $path`);
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
  if (typeof p !== 'string') throw new OpError('BAD_REQUEST', 'path must be a string');
  // assertSafePath throws plain Error — wire-facing paths map to BAD_REQUEST
  // (the act result-path assert below stays loud-INTERNAL: handler bug, not caller's).
  try { assertSafePath(p); }
  catch (e) { throw new OpError('BAD_REQUEST', e instanceof Error ? e.message : String(e)); }
  return p;
}

function vPaths(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new OpError('BAD_REQUEST', 'paths must be an array');
  return v.map(vPath);
}

function toErrFrame(id: number, e: unknown): ErrFrame {
  if (e instanceof OpError) return { id, err: { code: e.code, msg: e.message } };
  console.error('[twp] handler error:', e);
  return { id, err: { code: 'INTERNAL', msg: e instanceof Error ? e.message : String(e) } };
}

function toError(err: ErrFrame['err']): Error {
  return err.code === 'INTERNAL' ? new Error(err.msg) : new OpError(err.code, err.msg);
}

/** Write ctx carrying the client mutation id — events echo it as `by` (gk8.1). */
function writeCtx(opId: string | undefined): { opId: string } | undefined {
  return opId ? { opId } : undefined;
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

  function watchCaps(s: PeerServe) {
    const getPerm = s.tree.getPerm?.bind(s.tree);
    const hooks = s.hooks;
    if (!getPerm || !hooks) throw new OpError('BAD_REQUEST', 'watch unsupported by this peer');
    return { getPerm, watch: hooks.watch.bind(hooks), unwatch: hooks.unwatch.bind(hooks) };
  }

  async function resolveServe(): Promise<PeerServe> {
    if (!serve) throw new OpError('FORBIDDEN', 'peer does not serve (no export policy)');
    return serve();
  }

  function handle(frame: ReqFrame, ctx?: unknown): Promise<ResFrame> | AsyncIterable<ResFrame> {
    if (frame.op === 'act' && frame.stream) return handleActStream(frame);
    return handleUnary(frame, ctx);
  }

  async function handleUnary(frame: ReqFrame, ctx?: unknown): Promise<ResFrame> {
    try {
      const s = await resolveServe();
      const ok = (v: unknown): OkFrame => (s.at ? { id: frame.id, ok: v, at: s.at() } : { id: frame.id, ok: v });

      switch (frame.op) {
        case 'get': {
          const path = vPath(frame.path);
          const cap = frame.watch ? watchCaps(s) : undefined;
          const node = await s.tree.get(path);
          if (cap && node && ((await cap.getPerm(path)) & S)) cap.watch([path]);
          return ok(node);
        }

        case 'resolve': {
          const path = vPath(frame.path);
          const cap = frame.watch ? watchCaps(s) : undefined;
          const node = await s.tree.get(path);
          if (!node) return ok([]);
          const result: NodeData[] = [node];
          if (cap && ((await cap.getPerm(path)) & S)) cap.watch([path]);
          if (isRef(node)) {
            const target = await s.tree.get(node.$ref);
            if (target) {
              result.push(target);
              if (cap && ((await cap.getPerm(target.$path)) & S)) cap.watch([target.$path]);
            }
          }
          return ok(result);
        }

        case 'ls': {
          const path = vPath(frame.path);
          if (frame.query !== undefined) {
            if (typeof frame.query !== 'object' || frame.query === null || Array.isArray(frame.query)) {
              throw new OpError('BAD_REQUEST', 'ls.query must be an object');
            }
            // core-92z: a watch registered without callerWhere would silently
            // miss CDC events for query-filtered items — reject the combination
            // until Stage 6d wires the full ReadPlan into watch registration.
            if (frame.watch || frame.watchList) {
              throw new OpError('BAD_REQUEST', 'ls.query cannot be combined with watch/watchList until Stage 6d (core-92z)');
            }
          }
          if (frame.cursor !== undefined && typeof frame.cursor !== 'string') {
            throw new OpError('BAD_REQUEST', 'ls.cursor must be a string');
          }
          const cap = frame.watch ? watchCaps(s) : undefined;
          const watchList = frame.watchList ? s.hooks?.watchList?.bind(s.hooks) : undefined;
          if (frame.watchList && !watchList) throw new OpError('BAD_REQUEST', 'watchList unsupported by this peer');
          // ctx threaded to getChildren only — parity with the pre-TWP router;
          // uniform threading to all tree calls is a separate decision.
          const page = await s.tree.getChildren(
            path,
            { limit: frame.limit ?? DEFAULT_LS_LIMIT, offset: frame.offset, depth: frame.depth, query: frame.query, cursor: frame.cursor },
            ctx,
          );
          if (cap) {
            const watchable: string[] = [];
            for (const n of page.items) if ((await cap.getPerm(n.$path)) & S) watchable.push(n.$path);
            if (watchable.length) cap.watch(watchable);
          }
          watchList?.(path, page, !!frame.watch);
          const { queryMount: _qm, ...pub } = page;
          return ok(pub);
        }

        case 'set': {
          const path = vPath(frame.path);
          if (typeof frame.node !== 'object' || frame.node === null) throw new OpError('BAD_REQUEST', 'node must be an object');
          if (typeof frame.node.$type !== 'string') throw new OpError('BAD_REQUEST', 'node.$type required');
          // path field is authoritative; wire payload never carries $path/$patches (spec §6).
          const { $path: _wirePath, $patches: _patches, ...clean } = frame.node;
          await s.tree.set({ ...clean, $type: frame.node.$type, $path: path }, writeCtx(frame.opId));
          return ok(undefined);
        }

        case 'patch': {
          const path = vPath(frame.path);
          if (!Array.isArray(frame.ops)) throw new OpError('BAD_REQUEST', 'ops must be an array');
          await s.tree.patch(path, frame.ops, writeCtx(frame.opId));
          return ok(undefined);
        }

        case 'rm': {
          const path = vPath(frame.path);
          return ok(await s.tree.remove(path, writeCtx(frame.opId)));
        }

        case 'act': {
          const path = vPath(frame.path);
          if (typeof frame.action !== 'string' || !frame.action) throw new OpError('BAD_REQUEST', 'action must be a string');
          if (!s.execute) throw new OpError('BAD_REQUEST', 'peer does not execute actions');
          const cap = frame.watch ? watchCaps(s) : undefined;
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
          if (!getPerm) throw new OpError('BAD_REQUEST', 'perm unsupported by this peer');
          return ok(await getPerm.call(s.tree, path));
        }

        case 'sub': {
          const cap = watchCaps(s);
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
          const cap = watchCaps(s);
          const paths = vPaths(frame.paths);
          if (paths.length) cap.unwatch(paths);
          const prefixes = vPaths(frame.prefixes);
          if (prefixes.length) cap.unwatch(prefixes, { children: true });
          return ok(undefined);
        }
      }
    } catch (e) {
      return toErrFrame(frame.id, e);
    }
  }

  async function* handleActStream(frame: ActFrame): AsyncIterable<ResFrame> {
    let s: PeerServe;
    let req: ActReq;
    try {
      s = await resolveServe();
      if (!s.executeStream) throw new OpError('BAD_REQUEST', 'peer does not stream actions');
      const path = vPath(frame.path);
      if (typeof frame.action !== 'string' || !frame.action) throw new OpError('BAD_REQUEST', 'action must be a string');
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
      yield { id: frame.id, end: true };
    } catch (e) {
      if (ac.signal.aborted) yield { id: frame.id, end: true };
      else yield toErrFrame(frame.id, e);
    } finally {
      // Consumer teardown (iterator.return) must abort the handler's signal too.
      ac.abort();
      inflight.delete(frame.id);
    }
  }

  // ── requester side ──

  function call(build: (id: number) => ReqFrame): Promise<unknown> {
    const c = conn;
    if (!c) return Promise.reject(new Error('twp: peer not attached'));
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
          push({ id, err: { code: 'CONFLICT', msg: 'twp: peer not attached' } });
          endStream();
          return () => {};
        }
        streams.set(id, { push, end: endStream });
        c.send(build(id));
        return () => {
          if (streams.delete(id)) conn?.send({ op: 'cancel', id });
        };
      },
      { id, err: { code: 'RESOURCE_EXHAUSTED', msg: 'twp: stream overflow' } },
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
      get: (path: string, watch?: boolean) => call((id) => ({ id, op: 'get', path, watch })),
      resolve: (path: string, watch?: boolean) => call((id) => ({ id, op: 'resolve', path, watch })),
      ls: (path: string, o?: Omit<LsFrame, 'id' | 'op' | 'path'>) => call((id) => ({ id, op: 'ls', path, ...o })),
      set: (path: string, node: Record<string, unknown>, opId?: string) => call((id) => ({ id, op: 'set', path, node, opId })),
      patch: (path: string, ops: PatchOp[], opId?: string) => call((id) => ({ id, op: 'patch', path, ops, opId })),
      rm: (path: string, opId?: string) => call((id) => ({ id, op: 'rm', path, opId })),
      act: (a: ActReq & { watch?: boolean }) => call((id) => ({ id, op: 'act', ...a })),
      actStream: (a: ActReq) => callStream((id) => ({ id, op: 'act', stream: true, ...a })),
      perm: (path: string) => call((id) => ({ id, op: 'perm', path })),
      sub: (o: { paths?: string[]; prefixes?: string[] }) => call((id) => ({ id, op: 'sub', ...o })),
      unsub: (o: { paths?: string[]; prefixes?: string[] }) => call((id) => ({ id, op: 'unsub', ...o })),
    },
  };
}
