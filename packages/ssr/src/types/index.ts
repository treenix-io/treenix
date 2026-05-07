// Side-effect barrel: importing this module registers t.site, t.seo, t.route.
// t.route lives in @treenx/react (router-related, not SSR-specific) — re-exported
// here for backward compatibility with consumers that import from @treenx/ssr.

import './site';
import './seo';
import '@treenx/react/router/route';

export { Site } from './site';
export { Seo } from './seo';
export { Route } from '@treenx/react/router/route';
