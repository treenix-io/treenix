// installSsr — one-call wiring of the SSR pipeline into a treenix() instance.
//
// Boots a RouteIndex from /sys/routes/* and returns an HtmlHandler suitable
// for handing to t.listen({ htmlHandler }). Live updates: re-hydrates on
// every request for v0; a Phase 5 patch will subscribe to /sys/routes
// prefix events instead.

import type { Pipeline } from '@treenx/core/server/server';
import type { HtmlHandler } from '@treenx/core/server/server';
import type { NodeData } from '@treenx/core';
import { RouteIndex } from './route-index';
import { ssrHandler } from './handler';

export type InstallSsrOpts = {
  /** Skip rebuilding the route index per request — true for production. Default: rebuild every request. */
  cacheRoutes?: boolean;
  /** Optional Tailwind JIT — receives rendered HTML, returns CSS. Phase 5 wires the real one. */
  tailwindJit?: (html: string) => Promise<string> | string;
};

export async function installSsr(
  pipeline: Pipeline,
  opts: InstallSsrOpts = {},
): Promise<HtmlHandler> {
  // Side-effect: register Site/Seo/Route schemas so withValidation accepts nodes carrying them.
  await import('./types/index');

  const { tree } = pipeline;
  const routes = new RouteIndex();

  async function rebuild() {
    const page = await tree.getChildren('/sys/routes', { depth: -1 });
    routes.hydrate(page.items as NodeData[]);
  }

  await rebuild();

  return async (req, url) => {
    if (!opts.cacheRoutes) await rebuild();
    return ssrHandler(
      { pathname: url.pathname, query: url.searchParams, isAdmin: false },
      { routes, tree, tailwindJit: opts.tailwindJit },
    );
  };
}
