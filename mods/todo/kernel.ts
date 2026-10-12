import { registerNativeTodo } from './native';
import { registerKernelSeeds } from '@treenx/core/kernel';
import { nativeSeed } from '@treenx/core/mod/native-prefab';
import { todoSeed } from './seed-data';

registerNativeTodo();
registerKernelSeeds(nativeSeed('todo', todoSeed));
