// tRPC transport for Treenix Client.
// HTTP batch for queries/mutations, SSE for subscriptions.

import type { NodeData } from '#core';
import type { PatchOp } from '#tree';
import type { TreeRouter } from '#server/trpc';
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import type { TreenixClient, WatchSub } from './index';

export type TrpcTransportOpts = {
  url: string;
  getToken?: () => string | null;
  token?: string;
  fetch?: (input: any, init?: any) => Promise<Response>;
};

export function createTrpcTransport(opts: TrpcTransportOpts): TreenixClient & { trpc: ReturnType<typeof createTRPCClient<TreeRouter>> } {
  const getToken = opts.getToken ?? (() => opts.token ?? null);

  // Forward declaration — closure captures the binding, called only at subscribe time when trpc is defined.
  let trpc!: ReturnType<typeof createTRPCClient<TreeRouter>>;
  trpc = createTRPCClient<TreeRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: `${opts.url}/trpc/`,
          // Mint a short-lived stream token via authed mutation; called on every (re)connect.
          // Skip the mint when no session token is present — calling mintStreamToken without
          // Authorization returns UNAUTHORIZED and the subscription would loop on it. Throw
          // a clean error so the link surfaces "no session" instead of spamming the server.
          connectionParams: async () => {
            if (!getToken()) throw new Error('No session — login before subscribing');
            const { token } = await trpc.mintStreamToken.mutate();
            return { token };
          },
        }),
        false: httpBatchLink({
          url: `${opts.url}/trpc/`,
          maxURLLength: 2048,
          headers: () => {
            const t = getToken();
            return t ? { Authorization: `Bearer ${t}` } : {};
          },
          ...(opts.fetch && { fetch: opts.fetch }),
        }),
      }),
    ],
  });

  // Shared SSE connection for watchPath — lazy, one per transport
  let eventSub: WatchSub | null = null;
  const pathCbs = new Map<string, Set<(e: any) => void>>();

  function ensureSSE() {
    if (eventSub) return;
    // Defer subscription until a session token exists — avoids triggering connectionParams
    // (which would call mintStreamToken without Authorization and fail). When a later
    // watchPath call fires after login, this kicks in.
    if (!getToken()) return;
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
