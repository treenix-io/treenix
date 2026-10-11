import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeAuditManifest } from './native-history';

/** Compose the existing native owner for module discovery. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest: nativeAuditManifest() };
}
