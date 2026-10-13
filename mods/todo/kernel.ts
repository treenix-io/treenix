import { nativeTodoManifest } from './native';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '#prefab/seed';
import { todoSeed } from './seed-data';

export default function createNativeTodo(): NativeModuleDeployment {
  return { manifest: nativeTodoManifest(), seeds: nativeSeed('todo', todoSeed) };
}
