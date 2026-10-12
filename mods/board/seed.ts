// Board seed — kanban at /board, typed columns with query mounts

import { registerPrefab } from '@treenx/core/mod';
import { boardSeed } from './seed-data';

registerPrefab('board', 'seed', [...boardSeed], undefined, { tier: 'core' });
