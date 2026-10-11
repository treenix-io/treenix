import { nativePrefabManifest } from '#mod/native-prefab';
import type { NativeModuleDeployment } from '#kernel/manifest';

/** Bind prefab schemas and deployment actions to the native module catalog. */
export default async function createNativePrefab(): Promise<NativeModuleDeployment> {
  return { manifest: await nativePrefabManifest() };
}
