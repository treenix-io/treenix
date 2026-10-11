import { nativePrefabManifest } from '#mod/native-prefab';
import type { NativeModuleDeployment } from '#kernel/manifest';

/** Bind the real prefab owner through an explicit compiled deployment entry. */
export default async function prefab(): Promise<NativeModuleDeployment> {
  return { manifest: await nativePrefabManifest() };
}
