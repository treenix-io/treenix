import type { NativeModuleDeployment } from '#kernel/manifest';

/** The old catch-all has no definitions; native platform, authentication and logs have separate owners. */
export default function treenixModule(): NativeModuleDeployment {
  return { manifest: { id: '@treenx/core/treenix', types: [], security: [], open: [] } };
}
