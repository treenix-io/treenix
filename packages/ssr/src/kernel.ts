import type { ModuleManifest } from '@treenx/core/kernel/types';
import site from './types/schemas/t.site.json' with { type: 'json' };
import seo from './types/schemas/t.seo.json' with { type: 'json' };

/** Native ownership for the existing SSR marker components. */
export const ssrModule: ModuleManifest = {
  id: '@treenx/ssr',
  types: [
    { name: 't.site', module: '@treenx/ssr', security: 'ordinary', schema: site, version: 1, actions: {} },
    { name: 't.seo', module: '@treenx/ssr', security: 'ordinary', schema: seo, version: 1, actions: {} },
  ],
  security: [], open: [],
};
