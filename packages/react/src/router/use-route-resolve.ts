// useRouteResolve — client hook over the unified /sys/routes index.
// Composes useChildren('/sys/routes') with the pure resolveRoute. Watches the
// directory so newly-seeded routes hot-update without a refresh.
//
// Returns the matched /sys/routes/<key> node directly. Ref-following is the
// 'ref' type's responsibility via a `react:route` view — see ref-route.tsx.
// This keeps route metadata (prefix/index/wildcard) intact regardless of
// whether the route is a shell ($type: 't.view.shell') or a ref.

import { useMemo } from 'react';
import { useChildren } from '#hooks';
import { getRoute, resolveRoute, resolveTarget, type ResolveResult } from './route-resolve';

export type RouteResolveQuery = {
  /** Match result, or null when no route matched (or while loading + empty). */
  result: ResolveResult;
  /** Resolved target tree path for the current URL — `prefix + rest` (or
   *  `prefix + index` for empty rest). Null when no route matched. */
  target: string | null;
  /** Initial fetch in flight — distinguish "loading" from "not found". */
  loading: boolean;
  /** Matched route opts in for unauthenticated rendering (t.route.public). */
  isPublic: boolean;
};

export function useRouteResolve(pathname: string): RouteResolveQuery {
  const { data, loading } = useChildren('/sys/routes', { watch: true, watchNew: true });
  const result = useMemo(() => resolveRoute(pathname, data), [pathname, data]);
  const target = result ? resolveTarget(getRoute(result.node), result.rest) : null;
  const isPublic = !!result && getRoute(result.node)?.public === true;
  return { result, target, loading, isPublic };
}
