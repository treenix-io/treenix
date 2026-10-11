import { KernelError } from '@treenx/core/errors';
import type { NativeModuleDeployment, NativeModuleHost } from '@treenx/core/kernel/manifest';
import type {} from '@treenx/core/server/http-routes';
import { nativeMcpManifest } from './native-service';

/** Bind the service to the actual HTTP table owned by this deployment. */
export default function createMcpModule(host: NativeModuleHost): NativeModuleDeployment {
  if (host.httpRoutes === undefined) throw new KernelError('UNAVAILABLE', 'MCP requires its deployment HTTP route owner');
  return { manifest: nativeMcpManifest(host.httpRoutes) };
}
