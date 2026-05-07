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
import { resolveRoute, type ResolveResult } from './route-resolve';

export type RouteResolveQuery = {
  /** Match result, or null when no route matched (or while loading + empty). */
  result: ResolveResult;
  /** Initial fetch in flight — distinguish "loading" from "not found". */
  loading: boolean;
};

export function useRouteResolve(pathname: string): RouteResolveQuery {
  const { data, loading } = useChildren('/sys/routes', { watch: true, watchNew: true });
  const result = useMemo(() => resolveRoute(pathname, data), [pathname, data]);
  return { result, loading };
}
