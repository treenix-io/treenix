import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import schema0 from './schemas/t.route.json' with { type: 'json' };

export const manifest: ModuleManifest = {
  id: '@treenx/router',
  types: [
    { name: 't.route', module: '@treenx/router', security: 'ordinary', version: 0, schema: schema0, actions: {} },
  ],
  security: [],
  open: [],
};

/** Publish route metadata through its owning native module. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest };
}
