import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { ModuleManifest, ServiceHandler } from '@treenx/core/kernel/types';
import type { TwpHttpRoutes } from '@treenx/core/server/http-routes';
import { createMcpSession } from '#mcp/mcp-session';
import type { NativeMcpCoordinates, NativeMcpServerConfig } from '#mcp/native-types';
import { createNativeMcpServer } from '#mcp/native-tools';

/** Let the native HTTP binding own authentication and the request session lifetime. */
export function registerNativeMcpRoute(
  routes: TwpHttpRoutes,
  path = '/mcp',
  systemPath = '/sys/mcp/catalog',
  coordinates: NativeMcpCoordinates = {},
): () => void {
  return routes.register(path, async (request, response, session) => {
    const native = await createMcpSession(session, systemPath, coordinates);
    const server = createNativeMcpServer(native);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } finally {
      await transport.close();
      await server.close();
    }
  });
}

/** Install one service definition whose deployment supplies the native HTTP route owner. */
export function nativeMcpManifest(routes: TwpHttpRoutes): ModuleManifest {
  const service: ServiceHandler = async (node, session) => {
    const config = getComponent<NativeMcpServerConfig>(node, 'mcp.server');
    if (config === undefined)
      throw new KernelError('INVALID', 'MCP service has another owning component');
    const retire = registerNativeMcpRoute(routes, config.url, config.systemPath, {
      branchPath: config.branchPath,
    });
    const done = (async () => {
      try {
        for await (const frame of session.lane) if (frame.t === 'fail') throw frame.error;
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          (error.code !== 'CANCELLED' && error.code !== 'UNAUTHENTICATED')
        )
          throw error;
      } finally {
        retire();
      }
    })();
    return {
      done,
      async stop() {
        retire();
        await done;
      },
    };
  };
  return {
    id: 'treenix.mcp',
    open: [],
    security: [{ type: 'mcp.server', context: 'service', handler: service }],
    types: [
      {
        name: 'mcp.server',
        module: 'treenix.mcp',
        security: 'user-capability',
        version: 1,
        actions: {},
        actionsOnly: true,
        schema: {
          type: 'object',
          required: ['url', 'systemPath'],
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            systemPath: { type: 'string' },
            branchPath: { type: 'string' },
          },
        },
      },
    ],
  };
}
