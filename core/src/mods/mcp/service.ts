// MCP autostart service — starts/stops the MCP HTTP server via tree lifecycle

import { getComp } from '#comp';
import { register } from '#core';
import { createMcpHttpServer } from '#server/mcp';
import { McpConfig } from './types';

register('mcp.server', 'service', async (node, ctx) => {
  const config = getComp(node, McpConfig);
  const port = config?.port ?? (Number(process.env.MCP_PORT) || 3212);
  const server = createMcpHttpServer(ctx.store, port);

  return {
    stop: async () => {
      server.close();
      console.log(`[mcp] stopped :${port}`);
    },
  };
});
