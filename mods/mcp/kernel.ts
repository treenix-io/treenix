import { KernelError } from '@treenx/core/errors';
import type { NativeModuleDeployment, NativeModuleHost } from '@treenx/core/kernel/manifest';
import type {} from '@treenx/core/server/http-routes';
import { A, R, W } from '@treenx/core/kernel/types';
import { nativeSeed } from '#prefab/seed';
import { nativeMcpManifest } from './native-service';

/** Bind the service to the actual HTTP table owned by this deployment. */
export default function createMcpModule(host: NativeModuleHost): NativeModuleDeployment {
  if (host.httpRoutes === undefined) throw new KernelError('UNAVAILABLE', 'MCP requires its deployment HTTP route owner');
  return {
    manifest: nativeMcpManifest(host.httpRoutes),
    seeds: nativeSeed('mcp', [
      { $path: 'sys/mcp', $type: 'mcp.server', url: '/mcp', systemPath: '/sys/mcp/tools' },
      { $path: 'sys/mcp/tools', $type: 't.system' },
      { $path: 'sys/autostart/mcp', $type: 't.ref', $ref: '/sys/mcp' },
      { $path: 'auth/api-tokens', $type: 't.api.tokens', $acl: [
        { subject: { group: 'admins' }, grant: R | W | A },
        { subject: { group: 'authenticated' }, deny: R | W | A },
      ] },
    ], [], [
      { executor: 'sys/autostart', target: 'sys/mcp', grant: R },
      { executor: 'sys/mcp', target: 'sys/mcp', grant: R },
    ]),
  };
}
