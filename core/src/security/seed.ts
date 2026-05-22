import { A, R, S, W } from '#core';
import { registerPrefab } from '#mod';

// Auth infra — users and sessions.
// No explicit mount: children inherit the root storage unless the app overrides it.
registerPrefab('auth', 'seed', [
  { $path: 'auth', $type: 'dir', $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'public', p: 0 }] },
  { $path: 'auth/users', $type: 'dir',
    $acl: [{ g: 'authenticated', p: R | S }, { g: 'public', p: 0 }],
  },
  { $path: 'auth/sessions', $type: 'dir',
    $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }, { g: 'public', p: 0 }],
  },
], undefined, { tier: 'core' });
