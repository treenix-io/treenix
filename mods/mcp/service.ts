// MCP autostart service — attaches MCP transport to the main HTTP server.

import { getComponent, register } from '@treenx/core';
import { routeRegistry } from '@treenx/core/server/server';
import {
  createMcpResourceMetadataHandler,
  createMcpRouteHandler,
  protectedResourceMetadataPath,
} from './mcp-server';
import { McpConfig } from './types';

register('mcp.server', 'service', async (node, ctx) => {
  const config = getComponent(node, McpConfig);
  const host = config?.host ?? '127.0.0.1';
  const routePath = config?.url ?? '/mcp';
  const target = config?.target ?? '/sys/mcp/tools';
  const authorizationServer = config?.authorizationServer || process.env.MCP_AUTHORIZATION_SERVER || '';
  const routeOpts = { routePath, target, authorizationServer };
  const handler = createMcpRouteHandler(ctx.tree, host, routeOpts);
  const metadataPath = protectedResourceMetadataPath(routePath);
  const metadataHandler = createMcpResourceMetadataHandler(routeOpts);

  routeRegistry.set(routePath, handler);
  routeRegistry.set(metadataPath, metadataHandler);
  console.log(`[mcp] route ${routePath} -> ${target}; auth metadata ${metadataPath}`);

  return {
    stop: async () => {
      if (routeRegistry.get(routePath) === handler) routeRegistry.delete(routePath);
      if (routeRegistry.get(metadataPath) === metadataHandler) routeRegistry.delete(metadataPath);
      console.log(`[mcp] unregistered ${routePath}`);
    },
  };
});
