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

export function createTrpcTransport(opts: TrpcTransportOpts): TreenixClient & { trpc: ReturnType<typeof createTRPCClient<TreeRouter>> } {
  const getToken = opts.getToken ?? (() => opts.token ?? null);

  // Per-instance watch-ownership token (core-anz4.28): the AUTH token is shared
  // across consumers, so only a client-minted id tells the server WHICH consumer
  // holds a watch — without it every registration lands on the shared legacy
  // hold and one consumer's release strips the others. Mirrors React's TAB_TOKEN.
  const watchToken: string =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 10);

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
          eventSourceOptions: { withCredentials: true },
        }),
        false: httpBatchLink({
          url: `${opts.url}/trpc/`,
          maxURLLength: 2048,
          headers: () => {
            const t = getToken();
            return t ? { Authorization: `Bearer ${t}` } : {};
          },
          fetch: fetchImpl,
        }),
      }),
    ],
  });

  // Shared SSE connection for watchPath — lazy, one per transport
  let eventSub: WatchSub | null = null;
  const pathCbs = new Map<string, Set<(e: any) => void>>();

  function ensureSSE() {
    if (eventSub) return;
    eventSub = trpc.events.subscribe({ token: watchToken }, {
      onData: (event: any) => {
        // kriz: what if no path in event?
        if ('path' in event) pathCbs.get(event.path)?.forEach(cb => cb(event));
      },
    });
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
      const node = await trpc.get.query({ path, watch: true, token: watchToken });
      ensureSSE();
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
          if (!pathCbs.size && eventSub) { eventSub.unsubscribe(); eventSub = null; }
        },
      };
    },

    trpc,
    destroy() {
      if (eventSub) { eventSub.unsubscribe(); eventSub = null; }
      pathCbs.clear();
    },
  };
}
