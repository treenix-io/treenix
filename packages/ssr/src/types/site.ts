// t.site — SSR marker component. Presence + state='published' makes a route
// node renderable to HTML. Defaults are safe: draft + spa = opt-in publish/SSR.

import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

export type SiteMode = 'static' | 'hydrate' | 'spa';

/** Server-side rendering marker. Add to a route node to expose it as crawlable HTML. */
export class Site {
  /** Lifecycle: 'draft' = invisible to public, 'published' = served. */
  state: 'draft' | 'published' = 'draft';
  /** Render mode: 'static' = HTML only, 'hydrate' = HTML + client JS, 'spa' = no SSR. */
  mode: SiteMode = 'spa';
  /** Include the Tailwind browser CDN for runtime classes added after hydration. */
  tailwindRuntime?: boolean;
  /** HTTP cache hints. */
  cache?: {
    /** Cache-Control max-age in seconds. */ maxAge?: number;
    /** stale-while-revalidate in seconds. */ staleWhileRevalidate?: number;
    /** Emit weak ETag for cache validation. */ etag?: boolean;
  };
}

export const clientModules = [
  declareOpenModule('@treenx/ssr/site', [], [declareClientType('t.site', Site)]),
];
