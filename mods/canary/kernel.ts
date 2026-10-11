import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeCanaryManifest } from './native-service';

/** Compose the existing native owner for module discovery. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest: nativeCanaryManifest() };
}
