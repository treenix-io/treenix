// Side-effect barrel: importing this module registers t.site and t.seo.
// t.route lives in engine/mods/router as a directory mod — auto-loaded by
// the mod loader, no SSR-side wiring needed.

import './site';
import './seo';

export { Site } from './site';
export { Seo } from './seo';
