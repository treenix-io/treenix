import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { KernelError } from '@treenx/core/errors';
import type { ModuleManifest, ServiceHandler } from '@treenx/core/kernel/types';
import type { TwpHttpRoutes } from '@treenx/core/server/http-routes';
import { createMcpSession } from '#mcp/mcp-session';
import { createNativeMcpServer } from '#mcp/native-tools';

/** Let the native HTTP binding own authentication and the request session lifetime. */
export function registerNativeMcpRoute(routes: TwpHttpRoutes, path = '/mcp', systemPath = '/sys/mcp/catalog'): () => void {
  return routes.register(path, async (request, response, session) => {
    const native = await createMcpSession(session, systemPath);
    const server = createNativeMcpServer(native);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
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
    if (typeof node.url !== 'string' || typeof node.systemPath !== 'string') throw new KernelError('INVALID', 'MCP service route configuration is incomplete');
    const retire = registerNativeMcpRoute(routes, node.url, node.systemPath);
    const done = (async () => {
      try {
        for await (const frame of session.lane) if (frame.t === 'fail') throw frame.error;
      } catch (error) {
        if (!(error instanceof KernelError) || (error.code !== 'CANCELLED' && error.code !== 'UNAUTHENTICATED')) throw error;
      } finally { retire(); }
    })();
    return { done, async stop() { retire(); await done; } };
  };
  return { id: 'treenix.mcp', open: [], security: [{ type: 'mcp.server', context: 'service', handler: service }], types: [{
    name: 'mcp.server', module: 'treenix.mcp', security: 'user-capability', version: 1, actions: {}, actionsOnly: true,
    schema: { type: 'object', required: ['url', 'systemPath'], additionalProperties: false, properties: { url: { type: 'string' }, systemPath: { type: 'string' } } },
  }] };
}
