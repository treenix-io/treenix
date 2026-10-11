import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '@treenx/core/mod/native-prefab';
import { seedNodes } from './seed-data';
import schema0 from './schemas/t.view.shell.json' with { type: 'json' };

export const manifest: ModuleManifest = {
  id: '@treenx/view-shell',
  types: [
    { name: 't.view.shell', module: '@treenx/view-shell', security: 'ordinary', version: 0, schema: schema0, actions: {} },
  ],
  security: [],
  open: [],
};

/** Publish the existing viewer route schema through native module discovery. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest, seeds: nativeSeed('view-shell', seedNodes, [{ $path: '/sys/routes', $type: 't.dir' }]) };
}
