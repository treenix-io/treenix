import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '@treenx/core/mod/native-prefab';

/** Mount the deployment's named documentation directory and retain the existing welcome route. */
export default function createNativeOnboarding(): NativeModuleDeployment {
  return {
    manifest: { id: '@treenx/mods/onboarding', types: [], security: [], open: [] },
    seeds: nativeSeed(
      'onboarding',
      [
        {
          $path: 'docs',
          $type: 't.mount-point',
          '#mount': { $type: 't.mount.rawfs', pattern: '', directory: 'docs', external: 'none' },
          '#groups': { $type: 't.groups', list: ['admins'] },
        },
        { $path: 'sys/routes/_index', $type: 't.ref', $ref: '/docs/welcome.md' },
      ],
      [{ $path: '/sys/routes', $type: 't.dir' }],
    ),
  };
}
