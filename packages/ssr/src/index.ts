// Public surface — re-exports the type classes for consumers that want
// the TS definitions (e.g. SSR handler reading `node.site as Site`).

export { Site } from './types/site';
export { Seo } from './types/seo';
export { Route } from './types/route';

export { ssrHandler, type SsrRequest, type SsrResponse } from './handler';
export { RouteIndex } from './route-index';
export { ServerTreeSource } from './server-tree-source';
export { installSsr, type InstallSsrOpts } from './install';
export { MissingSiteViewError, SsrDataUnresolved } from './errors';
