import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import schema0 from './schemas/t.site.json' with { type: 'json' };
import schema1 from './schemas/t.seo.json' with { type: 'json' };

export const manifest: ModuleManifest = {
  id: '@treenx/ssr',
  types: [
    { name: 't.site', module: '@treenx/ssr', security: 'ordinary', version: 0, schema: schema0, actions: {} },
    { name: 't.seo', module: '@treenx/ssr', security: 'ordinary', version: 0, schema: schema1, actions: {} },
  ],
  security: [],
  open: [],
};

/** Publish the existing site and SEO schemas through native module discovery. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest };
}
