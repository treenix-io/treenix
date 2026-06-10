import { A, R, S, W } from '#core';
import { registerPrefab } from '#mod';

// Universal infra — works with any storage backend (FS, memory, Mongo)
registerPrefab('core', 'seed', [
  { $path: 'sys', $type: 't.system',
    $acl: [
      { g: 'admins', p: R | W | A | S },
      { g: 'authenticated', p: R },
      { g: 'public', p: R },
    ],
  },
  { $path: 'sys/types', $type: 'mount-point',
    '#mount': { $type: 't.mount.types' },
  },
  { $path: 'sys/mods', $type: 'mount-point',
    '#mount': { $type: 't.mount.mods' },
  },
  { $path: 'sys/autostart', $type: 'autostart' },
  // Soft-delete target (tree/trash.ts). Admin-only: trash holds full copies of
  // removed subtrees regardless of who removed them; purging an entry here is
  // the explicit hard delete.
  { $path: 'sys/trash', $type: 'dir',
    $acl: [
      { g: 'admins', p: R | W | A | S },
      { g: 'authenticated', p: 0 },
      { g: 'public', p: 0 },
    ],
  },
  { $path: 'proc', $type: 'mount-point',
    '#mount': { $type: 't.mount.memory' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/routes', $type: 'dir' },
], undefined, { tier: 'core' });
