import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import schema0 from './schemas/ui.table.json' with { type: 'json' };

const owner = '@treenx/mods/table';
export const manifest: ModuleManifest = {
  id: owner,
  types: [schema0].map((schema) => ({
    name: schema.$id,
    module: owner,
    security: 'ordinary',
    version: 0,
    schema,
    actions: {},
  })),
  security: [],
  open: [],
};

/** Publish the existing data schemas through their native owner. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest };
}
