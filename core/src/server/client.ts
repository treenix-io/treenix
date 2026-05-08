// Treenix tRPC Client — Node.js
// Creates tRPC client for tests and scripts (not browser).
// Uses `eventsource` npm package for SSE subscriptions.
// Each EventSource gets its own node:http connection to avoid undici pool contention
// when multiple SSE streams are open to the same origin.
//
// Auth model: cookie-based (post stream-token deletion). The node fetch wrapper below
// captures Set-Cookie headers from login/register and replays them on subsequent requests.
// SSE EventSource also gets the same cookie via the custom fetch.

import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink, type TRPCClient } from '@trpc/client';
import { EventSource as BaseEventSource } from 'eventsource';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { TreeRouter } from './trpc';

/** Token may be a string, null, or a getter — getter is re-evaluated per request so the
 *  client picks up new sessions after login without being recreated. Returning null/undefined
 *  from the getter sends no Authorization header (anonymous). */
export type TokenSource = string | null | undefined | (() => string | null | undefined);

function readToken(src: TokenSource): string | null {
  const v = typeof src === 'function' ? src() : src;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Make a fetch + EventSource pair that share a per-client cookie jar. Set-Cookie headers
 *  from login/register/devLogin are captured here and replayed on subsequent requests
 *  (including SSE EventSource handshakes), matching browser behavior for HttpOnly cookies. */
function makeCookieJar(getBearer: () => string | null) {
  let cookieHeader = '';

  function captureSetCookies(headers: Record<string, string | string[] | undefined>) {
    const sc = headers['set-cookie'];
    if (!sc) return;
    const list = Array.isArray(sc) ? sc : [sc];
    for (const raw of list) {
      // Take only `name=value` (drop attributes like Path/HttpOnly/etc.)
      const semi = raw.indexOf(';');
      const pair = (semi >= 0 ? raw.slice(0, semi) : raw).trim();
      if (!pair.includes('=')) continue;
      const name = pair.slice(0, pair.indexOf('='));
      // Replace existing cookie with the same name; otherwise append.
      const existing = cookieHeader.split('; ').filter(c => c && !c.startsWith(name + '='));
      cookieHeader = [...existing, pair].join('; ');
    }
  }

  function buildHeaders(init?: any): Record<string, string> {
    const h: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
    if (cookieHeader) h.Cookie = cookieHeader;
    const bearer = getBearer();
    if (bearer && !h.Authorization) h.Authorization = `Bearer ${bearer}`;
    return h;
  }

  /** fetch via node:http — each call opens its own socket, no pool contention.
   *  Returns a real `Response` so tRPC's `.json()` / `.text()` work. */
  function jarFetch(url: string | URL, init?: any): Promise<Response> {
    const parsed = new URL(String(url));
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: init?.method || 'GET',
        headers: buildHeaders(init),
        signal: init?.signal,
      }, (res) => {
        captureSetCookies(res.headers as Record<string, string | string[] | undefined>);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers.set(k, v);
          else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
        }
        const body = Readable.toWeb(res) as unknown as BodyInit;
        resolve(new Response(body, { status: res.statusCode ?? 200, headers }));
      });
      if (init?.body) req.write(init.body);
      req.on('error', reject);
      req.end();
    });
  }

  function makeEventSource() {
    return class JarEventSource extends BaseEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, { ...init, fetch: jarFetch as any });
      }
    };
  }

  return { jarFetch, makeEventSource };
}

export function createClient(url: string, token?: TokenSource): TRPCClient<TreeRouter> {
  const { jarFetch, makeEventSource } = makeCookieJar(() => readToken(token));
  let trpc!: TRPCClient<TreeRouter>;
  trpc = createTRPCClient<TreeRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url,
          EventSource: makeEventSource() as any,
        }),
        false: httpBatchLink({ url, maxURLLength: 2048, fetch: jarFetch as any }),
      }),
    ],
  });
  return trpc;
}
