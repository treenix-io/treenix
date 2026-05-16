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
    eventSub = trpc.events.subscribe(undefined as void, {
      onData: (event: any) => {
        if ('path' in event) pathCbs.get(event.path)?.forEach(cb => cb(event));
      },
    });
  }

  return {
    tree: {
      get: (path) => trpc.get.query({ path }) as Promise<NodeData | undefined>,
      getChildren: (path, opts) => trpc.getChildren.query({ path, ...opts }),
      set: (node) => trpc.set.mutate({ node: node as Record<string, unknown> }).then(() => {}),
      remove: (path) => trpc.remove.mutate({ path }).then(() => true),
      patch: (path, ops) => trpc.patch.mutate({ path, ops }).then(() => {}),
    },
    execute: (path, action, data, o) =>
      trpc.execute.mutate({ path, action, data, type: o?.type, key: o?.key }),
    watch: (onEvent) =>
      trpc.events.subscribe(undefined as void, { onData: onEvent }),

    watchPath: async (path, onEvent) => {
      const node = await trpc.get.query({ path, watch: true });
      ensureSSE();
      if (!pathCbs.has(path)) pathCbs.set(path, new Set());
      pathCbs.get(path)!.add(onEvent);
      return {
        node,
        unsubscribe() {
          const set = pathCbs.get(path);
          if (set) { set.delete(onEvent); if (!set.size) pathCbs.delete(path); }
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
