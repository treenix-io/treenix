import { registerNativeTodo } from './native';
import { registerKernelSeeds } from '@treenx/core/kernel';
import { nativeSeed } from '#prefab/seed';
import { todoSeed } from './seed-data';

registerNativeTodo();
registerKernelSeeds(nativeSeed('todo', todoSeed));
