import { nativeSystemManifest } from '#system/native-actions';
import { nativeCoreSeed } from '#system/native-seed';
import type { NativeModuleDeployment } from '#kernel/manifest';

/** Publish the native reflection actions owned by the system module. */
export default function platformModule(): NativeModuleDeployment {
  return { manifest: nativeSystemManifest(), seeds: nativeCoreSeed() };
}
