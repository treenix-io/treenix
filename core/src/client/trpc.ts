// tRPC transport for Treenity Client.
// HTTP batch for queries/mutations, SSE for subscriptions.

import type { NodeData } from '#core';
import type { TreeRouter } from '#server/trpc';
import { defaultPatch } from '#tree/patch';
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import type { TreenityClient, WatchSub } from './index';

export type TrpcTransportOpts = {
  url: string;
  getToken?: () => string | null;
  token?: string;
  fetch?: (input: any, init?: any) => Promise<Response>;
};

export function createTrpcTransport(opts: TrpcTransportOpts): TreenityClient & { trpc: ReturnType<typeof createTRPCClient<TreeRouter>> } {
  const getToken = opts.getToken ?? (() => opts.token ?? null);

  const trpc = createTRPCClient<TreeRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: `${opts.url}/trpc/`,
          connectionParams: () => {
            const t = getToken();
            return t ? { token: t } : {};
          },
        }),
        false: httpBatchLink({
          url: `${opts.url}/trpc/`,
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
      set: (node) => trpc.set.mutate({ node: node as Record<string, unknown> }),
      remove: (path) => trpc.remove.mutate({ path }).then(() => true),
      // TODO: add tRPC patch endpoint for single-RPC atomic patch
      patch: (path, ops) => defaultPatch(
        (p) => trpc.get.query({ path: p }) as Promise<NodeData | undefined>,
        (n) => trpc.set.mutate({ node: n as Record<string, unknown> }).then(() => {}),
        path, ops,
      ),
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
  };
}
