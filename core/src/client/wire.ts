// TWP-native Treenix client — TreenixClient over a frame Conn (spec §8).
// Transport-agnostic: loopback today, postMessage/WS bindings next (core-nin.3+).
// Watch lifecycle is leak-proof by construction: every watchPath registration
// is paired with an unsub frame when the last consumer for the path is gone
// (the core-m77 class). Events arrive as TWP EventFrames.

import type { NodeData } from '#core';
import type { ChildrenOpts, Page } from '#tree';
import type { EventFrame } from '#protocol/frames';
import { createPeer, type Conn, type Peer } from '#protocol/peer';
import type { TreenixClient } from './index';

export type WireClient = TreenixClient & {
  /** Underlying peer — actStream, sub/unsub, symmetric serving (advanced consumers). */
  peer: Peer;
};

export function createClient(conn: Conn): WireClient {
  const peer = createPeer();
  const detach = peer.attach(conn);

  // Per-path fan-out for watchPath consumers; refcounted so the server-side
  // watch is released exactly when the last local consumer unsubscribes.
  const pathCbs = new Map<string, Set<(e: EventFrame) => void>>();
  let offEvents: (() => void) | null = null;

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
    peer.req.unsub({ paths: [path] }).catch((e) => console.error('[twp-client] unsub failed:', e));
    if (!pathCbs.size && offEvents) { offEvents(); offEvents = null; }
  }

  return {
    tree: {
      get: (path) => peer.req.get(path) as Promise<NodeData | undefined>,
      getChildren: (path, opts?: ChildrenOpts) =>
        peer.req.ls(path, {
          limit: opts?.limit, offset: opts?.offset, depth: opts?.depth, query: opts?.query,
          watch: opts?.watch, watchList: opts?.watchNew,
        }) as Promise<Page<NodeData>>,
      set: (node) => peer.req.set(node.$path, node).then(() => {}),
      remove: (path) => peer.req.rm(path) as Promise<boolean>,
      patch: (path, ops) => peer.req.patch(path, ops).then(() => {}),
    },

    execute: (path, action, data, o) =>
      peer.req.act({ path, action, data, type: o?.type, key: o?.key }),

    watch: (onEvent) => {
      const off = peer.onEvent(onEvent);
      return { unsubscribe: off };
    },

    watchPath: async (path, onEvent) => {
      const node = await peer.req.get(path, true);
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

    destroy() {
      pathCbs.clear();
      if (offEvents) { offEvents(); offEvents = null; }
      detach();
      conn.close();
    },
  } satisfies WireClient;
}
