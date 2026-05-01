// Pure URL → /sys/routes/* matching.
//
// Single source of truth for both:
//   - useRouteResolve (client, this package)
//   - RouteIndex.resolve (server, @treenx/ssr — wraps this in an in-memory index)
//
// No React, no async, no I/O. Given the children of /sys/routes and a URL
// pathname, returns the matching route node + the URL tail that follows it.

import type { NodeData } from '@treenx/core';

export type ResolveResult = { node: NodeData; rest: string } | null;

/** Drop leading + trailing slashes; "/foo/bar/" → "foo/bar"; "/" → "". */
export function normalizeUrl(pathname: string | null | undefined): string {
  if (!pathname) return '';
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** /sys/routes/<key> → <key>; /sys/routes/_index → "" (root match). */
function urlKey(routePath: string | undefined): string | null {
  if (!routePath || !routePath.startsWith('/sys/routes/')) return null;
  const tail = routePath.slice('/sys/routes/'.length);
  return tail === '_index' ? '' : tail;
}

/** Read the `wildcard` bit off the node's `route` component without
 *  pulling in the full t.route TS type from @treenx/ssr (would invert the
 *  package dependency direction). */
function isWildcard(node: NodeData): boolean {
  const route = (node as Record<string, unknown>).route;
  return !!(route && typeof route === 'object' && (route as { wildcard?: boolean }).wildcard);
}

/** Resolve a URL pathname against a flat list of /sys/routes/* nodes.
 *  - Exact match wins over any wildcard.
 *  - Among wildcards, the longest matching prefix wins.
 *  - "_index" matches the root URL ("" / "/"). */
export function resolveRoute(pathname: string, routeNodes: readonly NodeData[]): ResolveResult {
  const norm = normalizeUrl(pathname);

  // 1. Exact match
  for (const n of routeNodes) {
    const key = urlKey(n.$path);
    if (key !== null && key === norm) return { node: n, rest: '' };
  }

  // 2. Wildcard fallback — longest-prefix wins. Empty-key wildcard catches all.
  let best: { node: NodeData; key: string } | null = null;
  for (const n of routeNodes) {
    const key = urlKey(n.$path);
    if (key === null || !isWildcard(n)) continue;
    const matches = key === '' || norm === key || norm.startsWith(key + '/');
    if (!matches) continue;
    if (!best || key.length > best.key.length) best = { node: n, key };
  }
  if (!best) return null;

  const rest = best.key === '' ? norm : norm.slice(best.key.length).replace(/^\//, '');
  return { node: best.node, rest };
}
