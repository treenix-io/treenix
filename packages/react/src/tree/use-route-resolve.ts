// useRouteResolve — client hook over the unified /sys/routes index.
// Composes useChildren('/sys/routes') with the pure resolveRoute. Watches the
// directory so newly-seeded routes hot-update without a refresh.
//
// Auto-follows `$type:'ref'` route nodes — `_index` referencing /demo/landing
// resolves to the landing node so the route view doesn't have to handle ref
// indirection itself.

import { useMemo } from 'react';
import { isRef } from '@treenx/core';
import { useChildren, usePath } from '#hooks';
import { resolveRoute, type ResolveResult } from './route-resolve';

export type RouteResolveQuery = {
  /** Match result, or null when no route matched (or while loading + empty). */
  result: ResolveResult;
  /** Initial fetch in flight — distinguish "loading" from "not found". */
  loading: boolean;
};

export function useRouteResolve(pathname: string): RouteResolveQuery {
  const { data, loading: loadingRoutes } = useChildren('/sys/routes', { watch: true, watchNew: true });
  const matched = useMemo(() => resolveRoute(pathname, data), [pathname, data]);

  // Follow ref → use target as the rendered node; keep matched.rest as-is.
  const refTarget = matched && isRef(matched.node) ? (matched.node as { $ref: string }).$ref : '';
  const { data: targetNode, loading: loadingTarget } = usePath(refTarget);

  const result = useMemo<ResolveResult>(() => {
    if (!matched) return null;
    if (!refTarget) return matched;
    if (!targetNode) return null;
    return { node: targetNode, rest: matched.rest };
  }, [matched, refTarget, targetNode]);

  return { result, loading: loadingRoutes || (!!refTarget && loadingTarget) };
}
