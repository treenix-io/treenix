import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import schema0 from './schemas/t.query.json' with { type: 'json' };

const owner = '@treenx/mods/query';
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

/** Publish the existing read-only schemas through their native owner. */
export default function createNativeQuery(): NativeModuleDeployment {
  return { manifest };
}
