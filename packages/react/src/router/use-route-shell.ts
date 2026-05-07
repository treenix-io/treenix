// useRouteShell — shared shell hook. Reads route metadata (prefix/index) from
// the route node and produces (target tree path, NavigateApi). Each shell view
// calls it with `preserveQuery` describing which query keys it owns and their
// default values to omit from URLs.
//
// makeHref returns null when a path falls outside the route's prefix → the
// shell's navigation context blocks links to anything outside this route.

import { useCallback, useMemo } from 'react';
import { type NodeData } from '@treenx/core';
import { getComponent } from '@treenx/core';
import {
  type NavigateApi, makeNavigateApi, navigateTo, useLocation,
} from '#navigate';
import { useRouteParams } from '#context/route-params';
import { Route } from './route';
import { normalizePrefix, resolveTarget, urlKey } from './route-resolve';

export type RouteShellOpts = {
  /** Query keys this shell preserves across navigations. Map key → default value
   *  to omit from the URL (so `?ctx=react` is dropped when 'react' is the default). */
  preserveQuery?: Record<string, string>;
};

/** Pure URL builder — extracted for unit testing without React. Returns null when
 *  the path falls outside the route's prefix (shell blocks the link). */
export function buildHref(
  path: string,
  route: Route | undefined,
  key: string,
  search: string,
  preserve?: Record<string, string>,
): string | null {
  const prefix = normalizePrefix(route?.prefix);
  let rel: string;
  if (prefix) {
    if (path !== prefix && !path.startsWith(prefix + '/')) return null;
    rel = path === prefix ? '' : path.slice(prefix.length + 1);
  } else {
    rel = path === '/' ? '' : path.replace(/^\//, '');
  }
  if (rel && rel === route?.index) rel = '';

  // key='' is the _index route — never prepend an empty segment (would yield "//foo").
  const base = rel
    ? (key ? `/${key}/${rel}` : `/${rel}`)
    : (key ? `/${key}` : '/');

  if (!preserve) return base;
  const params = new URLSearchParams(search);
  const kept: [string, string][] = [];
  for (const [k, def] of Object.entries(preserve)) {
    const v = params.get(k);
    if (v && v !== def) kept.push([k, v]);
  }
  if (!kept.length) return base;
  return `${base}?${kept.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export function useRouteShell(
  routeNode: NodeData,
  opts: RouteShellOpts = {},
): { target: string; nav: NavigateApi } {
  const { rest } = useRouteParams();
  const { search } = useLocation();

  const route = getComponent(routeNode, Route);
  const key = urlKey(routeNode.$path) || '';

  const target = useMemo(() => resolveTarget(route, rest), [route, rest]);

  const preserve = opts.preserveQuery;

  const makeHref = useCallback(
    (path: string): string | null => buildHref(path, route, key, search, preserve),
    [route, key, search, preserve],
  );

  const navigate = useCallback((path: string) => {
    const href = makeHref(path);
    // makeHref returns null for outside-prefix paths; block navigation.
    if (href === null) return false;
    return navigateTo(href);
  }, [makeHref]);

  const nav = useMemo(() => makeNavigateApi(navigate, makeHref), [navigate, makeHref]);
  return { target, nav };
}
