import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';


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
const declaredMcpServer = declareClientType('mcp.server', McpConfig);

/** API token manager for creating and revoking machine access credentials. */
export class ApiTokenManager {}

export interface ApiTokenCreated {
  id: string;
  token: string;
  userId: string;
}

export interface ApiTokenManager {
  /** @write Create a scoped machine credential; its token is returned once. */
  create(data: { name: string; groups?: string[]; scope: string[] }): Promise<ApiTokenCreated>;
  /** @write Revoke the credential identified by its token record. */
  revoke(data: { id: string }): Promise<{ revoked: boolean }>;
}
const declaredTApiTokens = declareClientType('t.api.tokens', ApiTokenManager, { noOptimistic: ['create', 'revoke'] });

/** Single API token. Plaintext is never stored; groups live on its account.
 * @version 1
 * @actionsOnly */
export class ApiToken {
  /** @title Token name */
  name = '';
  /** @title Account node @format path */
  accountPath = '';
  /** @title Authenticates as this principal */
  principal = '';
  /** @title Session node path @format path */
  sessionRef = '';
  /** @title Token fingerprint for visual identification */
  preview = '';
  /** @title Created at (epoch ms) */
  createdAt = 0;
}
const declaredTApiToken = declareClientType('t.api.token', ApiToken);

export const clientModules = [declareOpenModule('@treenx/mods/mcp/types', [], [
  declaredMcpServer,
  declaredTApiTokens,
  declaredTApiToken,
])];
