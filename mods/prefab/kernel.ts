import { nativePrefabManifest } from '@treenx/core/mod/native-prefab';
import { apply, instantiate, pull, revert } from '#prefab/propagation';

/** Keep the existing prefab type owner while moving propagation into its module. */
export default async function prefabModule() {
  const manifest = await nativePrefabManifest();
  return {
    manifest: {
      ...manifest,
      types: manifest.types.map((type) => ({
        ...type,
        actions: { ...type.actions, instantiate, pull, revert, apply },
      })),
    },
  };
}
