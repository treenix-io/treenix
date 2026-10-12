import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '#prefab/seed';
import { seedNodes } from './seed-data';
import schema0 from './schemas/t.editor.shell.json' with { type: 'json' };

export const manifest: ModuleManifest = {
  id: '@treenx/editor-shell',
  types: [
    { name: 't.editor.shell', module: '@treenx/editor-shell', security: 'ordinary', version: 0, schema: schema0, actions: {} },
  ],
  security: [],
  open: [],
};

/** Publish the existing editor route schema through native module discovery. */
export default function createNativeModule(): NativeModuleDeployment {
  return { manifest, seeds: nativeSeed('editor-shell', seedNodes, [{ $path: '/sys/routes', $type: 't.dir' }]) };
}
