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

/** Token may be a string, null, or a getter — getter is re-evaluated per request so the
 *  client picks up new sessions after login without being recreated. Returning null/undefined
 *  from the getter sends no Authorization header (anonymous). */
export type TokenSource = string | null | undefined | (() => string | null | undefined);

function readToken(src: TokenSource): string | null {
  const v = typeof src === 'function' ? src() : src;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function createClient(url: string, token?: TokenSource): TRPCClient<TreeRouter> {
  let trpc!: TRPCClient<TreeRouter>;
  trpc = createTRPCClient<TreeRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url,
          EventSource: createIsolatedEventSource() as any,
          // Mint short-lived stream token; called on every (re)connect.
          // Skip the mint when no session token is present — avoids spamming the server
          // with UNAUTHORIZED on logged-out clients (see server.ts onError).
          connectionParams: async () => {
            if (!readToken(token)) throw new Error('No session — login before subscribing');
            const { token: streamToken } = await trpc.mintStreamToken.mutate();
            return { token: streamToken };
          },
        }),
        false: httpBatchLink({
          url, maxURLLength: 2048,
          // Re-evaluated per request so a refreshed token after login is picked up
          // without recreating the client.
          headers: () => {
            const t = readToken(token);
            return t ? { Authorization: `Bearer ${t}` } : {};
          },
        }),
      }),
    ],
  });
  return trpc;
}
