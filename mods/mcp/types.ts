import { registerType } from '@treenx/core/comp';

export class McpConfig {
  port = 3212;
  /** @title Bind host */
  host = '127.0.0.1';
}
registerType('mcp.server', McpConfig);

export class ApiTokenManager {
  /** @mutation Create API token for an agent */
  create(_data: { name: string }) {
    console.log('API CREATE')
  }
  /** @mutation Revoke an API token by name */
  revoke(_data: { name: string }) {}
}
registerType('t.api.tokens', ApiTokenManager, { noOptimistic: ['create', 'revoke'] });
