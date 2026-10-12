import type { NativeModuleDeployment } from '#kernel/manifest';

/** Publish the named auth seed; the native bootstrap owns accounts, credentials and sessions. */
export default function nativeAuthModule(): NativeModuleDeployment {
  return {
    manifest: { id: '@treenx/core/auth', types: [], security: [], open: [] },
    seeds: {
      sources: [
        { $path: '/sys/mods', $type: 't.dir' },
        { $path: '/sys/mods/auth', $type: 't.dir' },
        { $path: '/sys/mods/auth/prefabs', $type: 't.dir' },
      ],
      prefabs: [
        {
          target: '/',
          allowAbsolute: true,
          source: {
            $path: '/sys/mods/auth/prefabs/seed',
            $type: 't.prefab',
            mod: 'auth',
            name: 'seed',
            nodes: [
              { $path: 'auth', $type: 't.dir' },
              { $path: 'auth/users', $type: 't.dir' },
              { $path: 'auth/credentials', $type: 't.dir' },
              { $path: 'auth/sessions', $type: 't.dir' },
            ],
            grants: [],
          },
        },
      ],
    },
  };
}
