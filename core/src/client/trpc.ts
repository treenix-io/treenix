// tRPC transport for Treenix Client.
// HTTP batch for queries/mutations, SSE for subscriptions.
//
// Auth model (post-cookie migration):
//   • Browsers: rely on the HttpOnly session cookie set by login/register/devLogin.
//     EventSource sends cookies natively; withCredentials covers cross-origin dev setups.
//   • Agents / MCP / tests: pass `token` or `getToken` — sent as `Authorization: Bearer ...`.
//     SSE EventSource cannot set headers, so node clients that need subscriptions go
//     through the cookie path too (custom fetch with a cookie jar) — see core/src/server/client.ts.

import type { NodeData } from '#core';
// kriz: not needed import
import type { PatchOp } from '#tree';
import type { TreeRouter } from '#server/trpc';
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import type { TreenixClient, WatchSub } from './index';

export type TrpcTransportOpts = {
  url: string;
  /** Optional bearer source (agent/MCP/tests). Browsers use the HttpOnly session cookie automatically. */
  getToken?: () => string | null;
  token?: string;
  fetch?: (input: any, init?: any) => Promise<Response>;
};

/** Max calls per HTTP batch. The server rejects larger batches with 400
 *  (server.ts) — every client batch link must split at this size. */
export const TRPC_MAX_BATCH = 100;

/** Client-minted watch-ownership id (core-anz4.28): the AUTH token is shared
 *  across consumers — only this id tells the server WHICH consumer holds a
 *  watch, so one consumer's release cannot strip the others' (React tabs mint
 *  one per tab as TAB_TOKEN). */
export function mintWatchToken(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 10);
}

/** EventSource with reconnect backoff. Native ES has no throttle: a dead
 *  server means a refused connect + console error every ~1s forever (and tRPC's
 *  sseStreamConsumer never recreates the ES itself, it rides the native retry).
 *  Network failures (underlying readyState CONNECTING) retry at 1s→30s
 *  exponential with jitter; HTTP-level rejections (underlying CLOSED: auth,
 *  bad content-type) stay fatal and propagate to tRPC unchanged. */
export class ThrottledEventSource {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;

  private es: EventSource | null = null;
  private listeners = new Map<string, Set<(event: Event) => void>>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private url: string, private init?: EventSourceInit) {
    this.connect();
  }

  private connect() {
    const es = this.es = new EventSource(this.url, this.init);

    // Internal handlers attach FIRST: wrapper readyState must be settled before
    // tRPC's own error listener inspects it (CLOSED → fatal, else reconnecting).
    es.addEventListener('open', () => {
      this.attempt = 0;
      this.readyState = this.OPEN;
    });
    es.addEventListener('error', () => {
      if (this.readyState === this.CLOSED) return;
      if (es.readyState === es.CLOSED) { this.readyState = this.CLOSED; return; }

      es.close(); // cancel the native ~1s retry — backoff owns the cadence
      this.es = null;
      this.readyState = this.CONNECTING;
      const delay = Math.min(1000 * 2 ** this.attempt++, 30_000);
      this.timer = setTimeout(() => this.connect(), delay * (0.75 + Math.random() * 0.5));
    });

    for (const [type, set] of this.listeners)
      for (const cb of set) es.addEventListener(type, cb);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, set = new Set());
    set.add(listener);
    this.es?.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
    this.es?.removeEventListener(type, listener);
  }

  close() {
    this.readyState = this.CLOSED;
    clearTimeout(this.timer);
    this.es?.close();
    this.es = null;
  }
}

export function createTrpcTransport(opts: TrpcTransportOpts): TreenixClient & { trpc: ReturnType<typeof createTRPCClient<TreeRouter>> } {
  const getToken = opts.getToken ?? (() => opts.token ?? null);
  const watchToken = mintWatchToken();

  // Browser fetch: include credentials so cookies flow on cross-origin (CORS) requests too.
  // Custom fetch from caller (e.g. node tests with a cookie jar) overrides.
  const defaultFetch = (input: any, init?: any) => fetch(input, { ...init, credentials: 'include' });
  const fetchImpl = opts.fetch ?? defaultFetch;

  let trpc!: ReturnType<typeof createTRPCClient<TreeRouter>>;
  trpc = createTRPCClient<TreeRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: `${opts.url}/trpc/`,
          EventSource: ThrottledEventSource,
          eventSourceOptions: { withCredentials: true },
        }),
        false: httpBatchLink({
          url: `${opts.url}/trpc/`,
          maxURLLength: 2048,
          maxItems: TRPC_MAX_BATCH,
          headers: () => {
            const t = getToken();
            return t ? { Authorization: `Bearer ${t}` } : {};
          },
          fetch: fetchImpl,
        }),
      }),
    ],
  });

  // Shared SSE lane for watchPath — lazy, one per transport. The server binds the token's lane before its first
  // event, and a watch registered before that loses the writes in between, so watchPath registers only once the
  // lane has spoken. `pending` counts watchPath calls between opening the lane and adding their callback: the
  // lane stays open for them even when every registered consumer leaves meanwhile.
  let eventSub: WatchSub | null = null;
  let lane: Promise<void> | null = null;
  let pending = 0;
  const pathCbs = new Map<string, Set<(e: any) => void>>();

  function openLane(): Promise<void> {
    if (lane) return lane;
    return lane = new Promise<void>((resolve, reject) => {
      eventSub = trpc.events.subscribe({ token: watchToken }, {
        onData: (event: any) => {
          resolve();
          if ('path' in event) {
            pathCbs.get(event.path)?.forEach(cb => cb(event));
            return;
          }
          // A path-less event (the reconnect verdict) concerns every watched path: each consumer refetches.
          for (const set of pathCbs.values()) for (const cb of [...set]) cb(event);
        },
        onError: (err: unknown) => {
          console.error('[trpc] event lane failed:', err);
          eventSub = null;
          lane = null;
          reject(err);
        },
      });
    });
  }

  function closeLaneIfIdle() {
    if (pathCbs.size || pending || !eventSub) return;
    eventSub.unsubscribe();
    eventSub = null;
    lane = null;
  }

  const tree: TreenixClient['tree'] = {
    get: (path) => trpc.get.query({ path }) as Promise<NodeData | undefined>,
    getChildren: (path, opts) =>
      trpc.getChildren.query({ path, ...opts, ...(opts?.watch || opts?.watchNew ? { token: watchToken } : {}) }),
    // Transport receipts are OPAQUE (core-ns6p.2): `changes: null` = committed,
    // contents unknown — the authority's images stay server-side until the
    // anz4.13 wire-ack upgrade. rm's boolean keeps known no-ops honest.
    set: (node) => trpc.set.mutate({ node: node as Record<string, unknown> }).then(() => ({ changes: null })),
    remove: (path) => trpc.remove.mutate({ path }).then((ok) => ({ changes: ok ? null : [] })),
    patch: (path, ops) => trpc.patch.mutate({ path, ops }).then(() => ({ changes: null })),
    // Tree.execute capability (core-pxlu): actions run on the server side that
    // owns this tree. Presence of this method marks the tree as a foreign
    // authority for mount adapters (t.mount.tree.trpc → repath forwards it).
    execute: (path, action, data, o) =>
      trpc.execute.mutate({ path, action, data, type: o?.type, key: o?.key, opId: o?.opId }),
  };

  return {
    tree,
    execute: (path, action, data, o) => tree.execute!(path, action, data, o),
    watch: (onEvent) =>
      trpc.events.subscribe({ token: watchToken }, { onData: onEvent }),

    // kriz: repeated in starter why? should reuse!
    watchPath: async (path, onEvent) => {
      let node: NodeData | undefined;
      pending++;
      try {
        await openLane();
        node = await trpc.get.query({ path, watch: true, token: watchToken });
      } catch (e) {
        pending--;
        closeLaneIfIdle();
        throw e;
      }
      pending--;

      // kriz: patchCbs.get, if !found -> add; equals, then found.add. dont (has + get)
      if (!pathCbs.has(path)) pathCbs.set(path, new Set());
      pathCbs.get(path)!.add(onEvent);
      return {
        node,
        unsubscribe() {
          const set = pathCbs.get(path);
          if (set) {
            set.delete(onEvent);
            if (!set.size) {
              pathCbs.delete(path);
              // core-m77: get{watch:true} registered a server-side watch — release it
              // with the last local consumer, or it leaks for the session's lifetime.
              trpc.unwatch.mutate({ paths: [path], token: watchToken })
                .catch((e: unknown) => console.error('[trpc] unwatch failed:', path, e));
            }
          }
          closeLaneIfIdle();
        },
      };
    },

    trpc,
    destroy() {
      if (eventSub) { eventSub.unsubscribe(); eventSub = null; }
      lane = null;
      pathCbs.clear();
    },
  };
}
