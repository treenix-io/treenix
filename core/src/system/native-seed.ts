import type { NativeSeedDefinition } from '#mod/native-prefab';
import { A, R, W } from '#kernel/types';

/** Declare native infrastructure while bootstrap retains ownership of existing system nodes. */
export function nativeCoreSeed(): NativeSeedDefinition {
  return {
    sources: [
      { $path: '/sys/mods', $type: 't.dir' },
      { $path: '/sys/mods/core', $type: 't.dir' },
      { $path: '/sys/mods/core/prefabs', $type: 't.dir' },
    ],
    prefabs: [
      {
        target: '/',
        allowAbsolute: true,
        source: {
          $path: '/sys/mods/core/prefabs/seed',
          $type: 't.prefab',
          mod: 'core',
          name: 'seed',
          nodes: [
            { $path: 'sys', $type: 't.dir' },
            { $path: 'sys/types', $type: 't.dir' },
            { $path: 'sys/mods', $type: 't.dir' },
            { $path: 'sys/autostart', $type: 't.autostart' },
            {
              $path: 'sys/trash',
              $type: 't.dir',
              $acl: [{ subject: { group: 'admins' }, grant: R | W | A }],
            },
            {
              $path: 'proc',
              $type: 't.mount-point',
              '#mount': { $type: 't.mount.memory', pattern: '' },
              $acl: [{ subject: { group: 'public' }, grant: R }],
            },
            { $path: 'sys/routes', $type: 't.dir' },
          ],
          grants: [{ executor: 'sys/autostart', target: 'sys/autostart', grant: R }],
        },
      },
    ],
  };
}
