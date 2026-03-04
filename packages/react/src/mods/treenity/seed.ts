import { type NodeData, R, S } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('core', 'seed', [
  { $path: 'sys', $type: 'treenity.system' },
  { $path: 'auth', $type: 'dir' },
  { $path: 'auth/users', $type: 'mount-point',
    connection: { $type: 'connection', db: 'treenity', collection: 'users' },
    mount: { $type: 't.mount.mongo' },
    $acl: [{ g: 'authenticated', p: R | S }, { g: 'public', p: 0 }],
  },
  { $path: 'sys/types', $type: 'mount-point',
    mount: { $type: 't.mount.types' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/mods', $type: 'mount-point',
    mount: { $type: 't.mount.mods' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'auth/sessions', $type: 'mount-point',
    connection: { $type: 'connection', db: 'treenity', collection: 'sessions' },
    mount: { $type: 't.mount.mongo' },
  },
  { $path: 'mnt', $type: 'dir' },
  { $path: 'mnt/orders', $type: 't.mount.mongo',
    connection: { $type: 'connection', db: 'treenity', collection: 'orders' },
  },
  { $path: 'entities', $type: 'dir' },
  { $path: 'demo', $type: 'dir',
    metadata: { $type: 'metadata', title: 'Demo Node', description: 'Try calling actions' },
    status: { $type: 'status', value: 'draft' },
    counter: { $type: 'counter', count: 0 },
  },
  { $path: 'llm', $type: 't.llm' },
  { $path: 'sys/mcp', $type: 'mcp.server', port: 0 },
  { $path: 'demo/sensors', $type: 'examples.demo.sensor',
    mount: { $type: 't.mount.memory' },
  },
  { $path: 'sys/claude-search', $type: 'claude-search' },
  { $path: 'proc', $type: 'mount-point',
    mount: { $type: 't.mount.memory' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/autostart', $type: 'autostart' },
  { $path: '/sys/autostart/mcp', $type: 'ref', $ref: '/sys/mcp' },
  { $path: '/sys/autostart/claude-search', $type: 'ref', $ref: '/sys/claude-search' },
  { $path: '/sys/autostart/sensors', $type: 'ref', $ref: '/demo/sensors' },
] as NodeData[], (nodes) => {
  // MCP port from env
  const mcpPort = Number(process.env.MCP_PORT) || 3212;
  let result = nodes.map(n =>
    n.$path === 'sys/mcp' ? { ...n, port: mcpPort } : n,
  );

  return result;
}, { tier: 'core' });
