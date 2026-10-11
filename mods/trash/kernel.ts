import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { createTrashManifest } from './native';

/** Bind the native deletion view to its declared root scope. */
export default function createNativeTrash(): NativeModuleDeployment {
  return { manifest: createTrashManifest() };
}
