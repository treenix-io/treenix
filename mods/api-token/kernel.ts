import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeApiTokenManifest } from '../mcp/native-api-token';

/** Publish the existing token owner independently of HTTP route ownership. */
export default function createApiTokenModule(): NativeModuleDeployment {
  return { manifest: nativeApiTokenManifest() };
}
