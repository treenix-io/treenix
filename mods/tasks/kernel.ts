import { Task } from '#tasks/types';
import { fileURLToPath } from 'node:url';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import { nativeClassModule } from '#native-module';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';

export default function createNativeTasks(): NativeModuleDeployment {
  return {
    manifest: nativeClassModule(
      '@treenx/mods/tasks',
      {
        't.task': Task,
      },
      readSchemasFromDir(fileURLToPath(new URL('./schemas', import.meta.url))),
    ),
  };
}
