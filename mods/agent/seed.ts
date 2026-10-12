// Agent Office seed — /agents pool + agents, /guardian policies

import { registerPrefab } from '@treenx/core/mod';
import { agentSeed } from '#agent/seed-data';

registerPrefab('agent', 'seed', agentSeed);
