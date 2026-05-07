// Public surface — re-exports the type classes for consumers that want
// the TS definitions (e.g. SSR handler reading `node.site as Site`).

export { Site } from './types/site';
export { Seo } from './types/seo';
export { Route } from '@treenx/react/router/route';

export { ssrHandler, type SsrRequest, type SsrResponse, type RenderFn } from './handler';
export { RouteIndex } from './route-index';
export { ServerTreeSource } from './server-tree-source';
export { viteSsrPlugin, type ViteSsrOpts } from './vite-ssr';
export { MissingSiteViewError, SsrDataUnresolved } from './errors';
