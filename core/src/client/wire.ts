// TWP-native Treenix client — TreenixClient over a frame Conn (spec §8).
// Transport-agnostic: loopback today, postMessage/WS bindings next (core-nin.3+).
// Watch lifecycle is leak-proof by construction: every watchPath registration
// is paired with an unsub frame when the last consumer for the path is gone
// (the core-m77 class). Events arrive as TWP EventFrames.

import type { NodeData } from '#core';
import type { ChildrenOpts, Page } from '#tree';
import type { EventFrame, ResumeCursor } from '#protocol/frames';
import { createPeer, type Conn, type Peer } from '#protocol/peer';
import type { TreenixClient } from './index';

export type WireClient = TreenixClient & {
  /** Underlying peer — actStream, sub/unsub, symmetric serving (advanced consumers). */
  peer: Peer;
  /** Resume cursor for reconnecting bindings (core-anz4.10): max seq seen +
   *  the stream epoch (from reset frames; hi-ok once the handshake lands). */
  cursor(): ResumeCursor;
};

/** `token` = this consumer's watch-ownership id (anz4.28). Pass the SAME value
 *  the binding hands to connectEventFrames/attachWireSession — mismatched lane
 *  and registration tokens mean token-grace never releases this client's holds.
 *  Absent = shared legacy hold. */
export function createClient(conn: Conn, opts?: { token?: string }): WireClient {
  const peer = createPeer();
  const detach = peer.attach(conn);
  const token = opts?.token;

  // Per-path fan-out for watchPath consumers; refcounted so the server-side
  // watch is released exactly when the last local consumer unsubscribes.
  const pathCbs = new Map<string, Set<(e: EventFrame) => void>>();
  let offEvents: (() => void) | null = null;
  let destroyed = false;

  // Continuity lane (core-anz4.10/11) — always on, independent of pathCbs.
  // Watermark from stamped frames; a reset frame breaks continuity: adopt its
  // cursor (a stamped break carries the post-break epoch; a plain verdict
  // clears it — an epoch-less resume can only fail closed) and fan the reset
  // to every watchPath consumer so each refetches + re-registers its node.
  let lastSeq = 0;
  let epoch: string | undefined;
  const offCursor = peer.onEvent((e) => {
    if (e.ev === 'reset') {
      lastSeq = e.seq ?? 0;
      epoch = e.epoch;
      for (const set of pathCbs.values()) for (const cb of [...set]) cb(e);
      return;
    }
    if (typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
    // anz4.28e: dirty is the only epoch-stamped frame on a signal-only stream —
    // without adopting it the cursor stays epoch-less and resume reset-loops.
    if (e.ev === 'dirty' && e.epoch !== undefined) epoch = e.epoch;
  });

  function ensureEventRouting() {
    if (offEvents) return;
    offEvents = peer.onEvent((e) => {
      if ('path' in e) pathCbs.get(e.path)?.forEach((cb) => cb(e));
    });
  }

  function releasePath(path: string, cb: (e: EventFrame) => void) {
    const set = pathCbs.get(path);
    if (!set || !set.delete(cb)) return;
    if (set.size) return;
    pathCbs.delete(path);
    // unsub racing destroy is benign — server releases all watches on disconnect.
    peer.req.unsub({ paths: [path], token }).catch((e) => {
      if (!destroyed) console.error('[twp-client] unsub failed:', e);
    });
    if (!pathCbs.size && offEvents) { offEvents(); offEvents = null; }
  }

  const tree: WireClient['tree'] = {
    get: (path) => peer.req.get(path) as Promise<NodeData | undefined>,
    getChildren: (path, o?: ChildrenOpts) =>
      peer.req.ls(path, {
        limit: o?.limit, depth: o?.depth,
        query: o?.query, cursor: o?.cursor,
        watch: o?.watch, watchList: o?.watchNew,
        ...(o?.watch || o?.watchNew ? { token } : {}),
      }) as Promise<Page<NodeData>>,
    // Transport receipts are OPAQUE (core-ns6p.2): the authority's images stay
    // on the server; `changes: null` says "committed, contents unknown" —
    // never `[]`, which would claim a no-op. rm's boolean ack keeps the known
    // no-op distinguishable. Full acks land with the anz4.13 wire upgrade.
    set: (node) => peer.req.set(node.$path, node).then(() => ({ changes: null })),
    remove: (path) => peer.req.rm(path).then((ok) => ({ changes: ok ? null : [] })),
    patch: (path, ops) => peer.req.patch(path, ops).then(() => ({ changes: null })),
    // Tree.execute capability (core-pxlu): act is a native TWP frame op; the
    // serving side owns handler resolution and permissions. Presence marks
    // foreign authority for mount adapters (future t.mount.peer, core-nin.7).
    execute: (path, action, data, o) =>
      peer.req.act({ path, action, data, type: o?.type, key: o?.key, opId: o?.opId }),
  };

  return {
    tree,

    execute: (path, action, data, o) => tree.execute!(path, action, data, o),

    watch: (onEvent) => {
      const off = peer.onEvent(onEvent);
      return { unsubscribe: off };
    },

    // No node cache here — pathCbs is pure fan-out, the initial image is handed
    // over once: the §3.3 rev machine belongs to caching consumers, N/A here.
    watchPath: async (path, onEvent) => {
      const node = await peer.req.get(path, true, token);
      ensureEventRouting();
      let set = pathCbs.get(path);
      if (!set) { set = new Set(); pathCbs.set(path, set); }
      set.add(onEvent);
      return {
        node,
        unsubscribe: () => releasePath(path, onEvent),
      };
    },

    peer,

    cursor: () => (epoch === undefined ? { seq: lastSeq } : { seq: lastSeq, epoch }),

    destroy() {
      destroyed = true;
      pathCbs.clear();
      offCursor();
      if (offEvents) { offEvents(); offEvents = null; }
      detach();
      conn.close();
    },
  } satisfies WireClient;
}
