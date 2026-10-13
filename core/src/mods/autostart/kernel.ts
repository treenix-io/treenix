import { nativeAutostartManifest } from './native';
import type { NativeModuleDeployment } from '#kernel/manifest';

class Autostart {}

export default function createNativeAutostart(): NativeModuleDeployment {
  return { manifest: nativeAutostartManifest(Autostart) };
}
