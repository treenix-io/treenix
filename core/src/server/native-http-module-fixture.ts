import { nativeSystemManifest } from '#system/native-actions';
import type { NativeModuleDeployment } from '#kernel/manifest';

export default function systemModule(): NativeModuleDeployment {
  return { manifest: nativeSystemManifest() };
}
