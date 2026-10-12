import { registerPrefab } from '@treenx/core/mod';
import { idealSeed } from './seed-data';

registerPrefab('ideal', 'seed', [...idealSeed]);
