import { RowColLayout } from '#row-layout/types';
import { fileURLToPath } from 'node:url';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import { nativeClassModule } from '#native-module';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';

export default function createNativeRowLayout(): NativeModuleDeployment {
  return {
    manifest: nativeClassModule('@treenx/mods/row-layout', {
      'layout.row-col': RowColLayout,
    }, readSchemasFromDir(fileURLToPath(new URL('./schemas', import.meta.url)))),
  };
}
