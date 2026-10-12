import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';
import { KernelError } from '@treenx/core/errors';
import type { McpSession } from '#mcp/mcp-session';

/** Validate external tool arguments and bind them to one authenticated native session. */
export function createNativeMcpServer(session: McpSession): McpServer {
  const server = new McpServer({ name: 'treenix', version: '1.0.0' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const path = z.string().startsWith('/');

  async function tool(operation: Promise<unknown>) {
    try { return result(await operation); }
    catch (error) {
      if (!(error instanceof KernelError)) throw error;
      return { ...result({ code: error.code, message: error.message }), isError: true };
    }
  }

  server.registerTool('get_node', { inputSchema: { path } }, async input => tool(session.get_node(input)));
  server.registerTool('list_children', { inputSchema: { path } }, async input => tool(session.list_children(input)));
  server.registerTool('execute', { inputSchema: { path, action: z.string(), component: z.string().optional(), args: z.unknown() } }, async input => tool(session.execute(input)));
  server.registerTool('deploy_prefab', { inputSchema: { source: path, target: path, allowAbsolute: z.boolean().optional() } }, async input => tool(session.deploy_prefab(input)));
  server.registerTool('set_node', { inputSchema: { path, type: z.string(), fields: z.record(z.unknown()) } }, async input => tool(session.set_node({ node: { ...input.fields, $path: input.path, $type: input.type } })));
  server.registerTool('remove_node', { inputSchema: { path } }, async input => tool(session.remove_node(input)));
  server.registerTool('catalog', { inputSchema: {} }, async () => tool(session.catalog()));
  server.registerTool('describe_type', { inputSchema: { type: z.string() } }, async input => tool(session.describe_type(input)));
  server.registerTool('search_types', { inputSchema: { query: z.string() } }, async input => tool(session.search_types(input)));
  return server;
}
