// Treenity tRPC Client — Node.js
// Creates tRPC client for tests and scripts (not browser).
// Uses `eventsource` npm package for SSE subscriptions.

import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import { EventSource } from 'eventsource';
import type { TreeRouter } from './trpc';

export function createClient(url: string, token?: string) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return createTRPCClient<TreeRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url,
          EventSource: EventSource as any,
          connectionParams: () => (token ? { token } : {}),
        }),
        false: httpBatchLink({ url, headers: () => headers }),
      }),
    ],
  });
}
