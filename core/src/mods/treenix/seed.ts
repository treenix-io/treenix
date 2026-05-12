import { A, type NodeData, R, S, W } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

// Universal infra — works with any storage backend (FS, memory, Mongo)
registerPrefab('core', 'seed', [
  { $path: 'sys', $type: 'treenix.system',
    $acl: [
      { g: 'admins', p: R | W | A | S },
      { g: 'authenticated', p: R },
      { g: 'public', p: R },
    ],
  },
  { $path: 'sys/types', $type: 'mount-point',
    mount: { $type: 't.mount.types' },
  },
  { $path: 'sys/mods', $type: 'mount-point',
    mount: { $type: 't.mount.mods' },
  },
  { $path: 'sys/mcp', $type: 'mcp.server', url: '/mcp', target: '/sys/mcp/tools' },
  { $path: 'sys/mcp/tools', $type: 'mcp.treenix' },
  { $path: 'sys/autostart', $type: 'autostart' },
  { $path: 'proc', $type: 'mount-point',
    mount: { $type: 't.mount.memory' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/autostart/mcp', $type: 'ref', $ref: '/sys/mcp' },
  { $path: 'sys/routes', $type: 'dir' },
  { $path: 'sys/llm', $type: 't.llm' },
] as NodeData[], undefined, { tier: 'core' });

// Auth infra — users, sessions, API tokens.
// No explicit mount — children inherit the root overlay (FS by default).
// For Mongo deployments, override these mount-points at the app level.
registerPrefab('auth', 'seed', [
  { $path: 'auth', $type: 'dir', $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'public', p: 0 }] },
  { $path: 'auth/users', $type: 'dir',
    $acl: [{ g: 'authenticated', p: R | S }, { g: 'public', p: 0 }],
  },
  { $path: 'auth/sessions', $type: 'dir',
    $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }, { g: 'public', p: 0 }],
  },
  { $path: 'auth/api-tokens', $type: 't.api.tokens',
    $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }],
  },
] as NodeData[], undefined, { tier: 'core' });
