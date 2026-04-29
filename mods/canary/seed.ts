import { type NodeData } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

registerPrefab('canary', 'seed', [
  { $path: 'canary', $type: 'dir' },
  { $path: 'canary/runner', $type: 'canary.runner' },
  { $path: 'sys/autostart/canary', $type: 'ref', $ref: '/canary/runner' },
] as NodeData[]);
