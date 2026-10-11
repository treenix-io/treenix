import type { ModuleManifest, Migration } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import site from './types/schemas/t.site.json' with { type: 'json' };
import seo from './types/schemas/t.seo.json' with { type: 'json' };

// Unversioned markers have the same fields as the initial native schemas.
const migrations: readonly Migration[] = [{ from: 0, to: 1, up: component => component }];

/** Native ownership for the existing SSR marker components. */
export const ssrModule: ModuleManifest = {
  id: '@treenx/ssr',
  types: [
    { name: 't.site', module: '@treenx/ssr', security: 'ordinary', schema: site, version: 1, actions: {} },
    { name: 't.seo', module: '@treenx/ssr', security: 'ordinary', schema: seo, version: 1, actions: {} },
  ],
  security: [
    { type: 't.site', context: 'migrate', handler: migrations },
    { type: 't.seo', context: 'migrate', handler: migrations },
  ],
  open: [],
};

/** Publish SSR metadata through its existing schema owner. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest: ssrModule };
}
