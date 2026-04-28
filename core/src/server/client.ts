// Treenix tRPC Client — Node.js
// Creates tRPC client for tests and scripts (not browser).
// Uses `eventsource` npm package for SSE subscriptions.
// Each EventSource gets its own node:http connection to avoid undici pool contention
// when multiple SSE streams are open to the same origin.

import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink, type TRPCClient } from '@trpc/client';
import { EventSource as BaseEventSource } from 'eventsource';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { TreeRouter } from './trpc';

/** fetch via node:http — each call opens its own socket, no pool contention */
function httpFetch(url: string | URL, init?: any): Promise<any> {
  const parsed = new URL(String(url));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: init?.method || 'GET',
      headers: init?.headers,
      signal: init?.signal,
    }, (res) => {
      resolve({
        status: res.statusCode,
        headers: new Headers(
          Object.entries(res.headers)
            .filter((e): e is [string, string] => typeof e[1] === 'string'),
        ),
        body: Readable.toWeb(res),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function createIsolatedEventSource() {
  return class IsolatedEventSource extends BaseEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, { ...init, fetch: httpFetch as any });
    }
  };
}

export function createClient(url: string, token?: string | null): TRPCClient<TreeRouter> {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return createTRPCClient<TreeRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url,
          EventSource: createIsolatedEventSource() as any,
          connectionParams: () => (token ? { token } : {}),
        }),
        false: httpBatchLink({ url, maxURLLength: 2048, headers: () => headers }),
      }),
    ],
  });
}
