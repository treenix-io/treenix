import { registerType } from '#comp';

/** MCP server — model context protocol endpoint for AI tool access */
export class McpConfig {
  port = 3212;
}
registerType('mcp.server', McpConfig);
