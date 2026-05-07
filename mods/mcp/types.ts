import { registerType } from '@treenx/core/comp';

/** Local MCP server binding used by agent clients and external tools. */
export class McpConfig {
  /** @title Legacy standalone port */
  port = 0;
  /** @title Bind host */
  host = '127.0.0.1';
  /** @title HTTP route */
  url = '/mcp';
  /** @title Tool node @format path @refType mcp.treenix */
  target = '/sys/mcp/tools';
  /** @title OAuth authorization server issuer */
  authorizationServer = '';
}
registerType('mcp.server', McpConfig);

/** API token manager for creating and revoking machine access credentials. */
export class ApiTokenManager {
  /** @write Create API token for an agent */
  create(_data: { name: string }) {
    console.log('API CREATE')
  }
  /** @write Revoke an API token by name */
  revoke(_data: { name: string }) {}
}
registerType('t.api.tokens', ApiTokenManager, { noOptimistic: ['create', 'revoke'] });
