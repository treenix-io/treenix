// MCP autostart service — starts/stops the MCP HTTP server via tree lifecycle

import { getComponent, register } from '@treenx/core';
import { createMcpHttpServer } from './mcp-server';
import { McpConfig } from './types';

register('mcp.server', 'service', async (node, ctx) => {
  const config = getComponent(node, McpConfig);
  const port = config?.port ?? (Number(process.env.MCP_PORT) || 3212);
  const host = config?.host ?? '127.0.0.1';
  const server = createMcpHttpServer(ctx.tree, port, host);

  return {
    stop: async () => {
      server.close();
      console.log(`[mcp] stopped :${port}`);
    },
  };
});
