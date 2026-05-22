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
    mount: { $type: 't.mount.types' },
  },
  { $path: 'sys/mods', $type: 'mount-point',
    mount: { $type: 't.mount.mods' },
  },
  { $path: 'sys/autostart', $type: 'autostart' },
  { $path: 'proc', $type: 'mount-point',
    mount: { $type: 't.mount.memory' },
    $acl: [{ g: 'public', p: R }],
  },
  { $path: 'sys/routes', $type: 'dir' },
], undefined, { tier: 'core' });
