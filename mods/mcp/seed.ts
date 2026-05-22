import { A, R, S, W } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

registerPrefab('mcp', 'seed', [
  { $path: 'sys/mcp', $type: 'mcp.server', url: '/mcp', target: '/sys/mcp/tools' },
  { $path: 'sys/mcp/tools', $type: 'mcp.treenix' },
  { $path: 'sys/autostart/mcp', $type: 'ref', $ref: '/sys/mcp' },
  { $path: 'auth/api-tokens', $type: 't.api.tokens',
    $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }],
  },
]);
