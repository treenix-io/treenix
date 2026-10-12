import { nativeSeed } from '#mod/native-prefab';
import { A, R, W } from '#kernel/types';

/** Declare native infrastructure while bootstrap retains ownership of existing system nodes. */
export function nativeCoreSeed() {
  return nativeSeed(
    'core',
    [
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
    [],
    [{ executor: 'sys/autostart', target: 'sys/autostart', grant: R }],
  );
}
