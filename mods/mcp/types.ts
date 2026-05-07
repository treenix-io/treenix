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

// R5-MCP-2: callers may scope token privileges via `groups`. Default is empty (least privilege).
// Allow only known groups; admins must be passed explicitly.
export const API_TOKEN_GROUPS = ['agents', 'authenticated', 'admins'] as const;
export type ApiTokenGroup = typeof API_TOKEN_GROUPS[number];

/** API token manager for creating and revoking machine access credentials. */
export class ApiTokenManager {
  /** @write Create API token for an agent. Token returned ONCE — server stores only sha256(token). */
  create(_data: { name: string; groups?: ApiTokenGroup[] }) {
    return { token: '', userId: '' };
  }
  /** @write Revoke an API token by name */
  revoke(_data: { name: string }) {}
}
registerType('t.api.tokens', ApiTokenManager, { noOptimistic: ['create', 'revoke'] });
