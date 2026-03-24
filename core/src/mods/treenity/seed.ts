import { A, type NodeData, R, S, W } from '@treenity/core';
import { registerPrefab } from '@treenity/core/mod';

// Universal infra — works with any storage backend (FS, memory, Mongo)
registerPrefab('core', 'seed', [
  { $path: 'sys', $type: 'treenity.system' },
  { $path: 'sys/types', $type: 'mount-point',
    mount: { $type: 't.mount.types' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/mods', $type: 'mount-point',
    mount: { $type: 't.mount.mods' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/mcp', $type: 'mcp.server', port: 0 },
  { $path: 'sys/autostart', $type: 'autostart' },
  { $path: 'proc', $type: 'mount-point',
    mount: { $type: 't.mount.memory' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/autostart/mcp', $type: 'ref', $ref: '/sys/mcp' },
  { $path: 'sys/routes', $type: 'dir' },
  { $path: 'sys/llm', $type: 't.llm' },
] as NodeData[], (nodes) => {
  const mcpPort = Number(process.env.MCP_PORT) || 3212;
  return nodes.map(n =>
    n.$path === 'sys/mcp' ? { ...n, port: mcpPort } : n,
  );
}, { tier: 'core' });

// Mongo-dependent infra — auth
registerPrefab('mongo', 'seed', [
  { $path: 'auth', $type: 'dir', $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'public', p: 0 }] },
  { $path: 'auth/users', $type: 'mount-point',
    mount: { $type: 't.mount.mongo', db: 'treenity', collection: 'users' },
    $acl: [{ g: 'authenticated', p: R | S }, { g: 'public', p: 0 }],
  },
  { $path: 'auth/sessions', $type: 'mount-point',
    mount: { $type: 't.mount.mongo', db: 'treenity', collection: 'sessions' },
    $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }, { g: 'public', p: 0 }],
  },
] as NodeData[]);
