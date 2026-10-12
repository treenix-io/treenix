import { nativePrefabManifest } from '#prefab/manifest';
import { apply, instantiate, pull, revert } from '#prefab/propagation';
import { assertNativeSeeds, installNativeSeeds, selectNativeSeeds } from '#prefab/install';
import { SOURCE_TYPE } from '#prefab/data';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';

/** Keep the existing prefab type owner while moving propagation into its module. */
export default async function prefabModule(): Promise<NativeModuleDeployment> {
  const manifest = await nativePrefabManifest();
  return {
    seedInstaller: {
      select: selectNativeSeeds,
      assert: assertNativeSeeds,
      install: installNativeSeeds,
    },
    manifest: {
      ...manifest,
      types: [
        ...manifest.types.map((type) => ({
          ...type,
          actions: { ...type.actions, instantiate, pull, revert, apply },
        })),
        {
          name: SOURCE_TYPE,
          module: manifest.id,
          security: 'ordinary',
          version: 0,
          schema: {
            type: 'object',
            required: ['body'],
            properties: {
              body: {
                type: 'object',
                required: ['$path', '$type'],
                properties: {
                  $path: { type: 'string' },
                  $type: { type: 'string' },
                },
              },
              implicit: { type: 'boolean' },
            },
          },
          actions: {},
        },
      ],
    },
  };
}
