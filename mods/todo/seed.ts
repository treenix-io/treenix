import { registerPrefab } from '@treenx/core/mod';
import { todoSeed } from './seed-data';

registerPrefab('todo', 'seed', [...todoSeed]);
