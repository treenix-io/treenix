// RouteParamsContext — exposed to views by the unified router so that route
// nodes (e.g. t.editor.shell, t.view.shell) can read the URL tail without
// regexing location.pathname. Populated by Router.tsx after resolving a
// /sys/routes/* node.

import { createContext, useContext } from 'react';

export type RouteParams = {
  /** URL segments after the matched route prefix. e.g. for /sys/routes/t
   *  + URL "/t/foo/bar", `rest` is "foo/bar". Empty string for root match. */
  rest: string;
  /** The full pathname that was resolved. Empty string in SSR contexts where
   *  the renderer doesn't bind the request URL into the tree. */
  full: string;
};

export const EMPTY: RouteParams = Object.freeze({ rest: '', full: '' });

export const RouteParamsContext = createContext<RouteParams>(EMPTY);

export function useRouteParams(): RouteParams {
  return useContext(RouteParamsContext);
}
