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
  /** @write Create API token for an agent. Token returned ONCE — server stores only sha256(token). Groups go on the user (no allowlist — admin trust). */
  async create(_data: { name: string; groups?: string[] }) {
    return { token: '', userId: '' };
  }
  /** @write Revoke an API token by name */
  async revoke(_data: { name: string }) {}
}
registerType('t.api.tokens', ApiTokenManager, { noOptimistic: ['create', 'revoke'] });

/** Single API token. Plaintext token is NEVER stored — sessionRef points to /auth/sessions/<sha256(token)>. Groups live on the user. */
export class ApiToken {
  /** @title Token name */
  name = '';
  /** @title Authenticates as this user id */
  userId = '';
  /** @title Session node path @format path */
  sessionRef = '';
  /** @title Token fingerprint (first6…last8) for visual identification */
  preview = '';
  /** @title Created at (epoch ms) */
  createdAt = 0;
}
registerType('t.api.token', ApiToken);
