import { nativeSimpleComponentsManifest } from './native';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';

export default function createNativeSimpleComponents(): NativeModuleDeployment {
  return { manifest: nativeSimpleComponentsManifest() };
}
