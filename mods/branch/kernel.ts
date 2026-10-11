import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeBranchManifest } from './native';

/** Publish the Branch Store and lifecycle through the native module owner. */
export default function createBranchModule(): NativeModuleDeployment {
  return { manifest: nativeBranchManifest() };
}
