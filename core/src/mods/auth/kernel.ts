import type { NativeModuleDeployment } from '#kernel/manifest';
import { nativeSeed } from '#mod/native-prefab';

/** Publish the named auth seed; the native bootstrap owns accounts, credentials and sessions. */
export default function nativeAuthModule(): NativeModuleDeployment {
  return {
    manifest: { id: '@treenx/core/auth', types: [], security: [], open: [] },
    seeds: nativeSeed('auth', [
      { $path: 'auth', $type: 't.dir' },
      { $path: 'auth/users', $type: 't.dir' },
      { $path: 'auth/credentials', $type: 't.dir' },
      { $path: 'auth/sessions', $type: 't.dir' },
    ]),
  };
}
