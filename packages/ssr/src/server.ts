// Server-side entry for @treenx/ssr.
// Phase 0 ships only the SSR-related component types (t.site, t.seo, t.route)
// so withValidation accepts them. Phase 3+ adds RouteIndex, ServerTreeSource,
// the request handler, and Tailwind JIT here.

import './types/index';
