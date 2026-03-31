import type { NodeData } from '@treenity/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('ideal', 'seed', [
  { $path: 'ideal', $type: 'dir' },
  { $path: 'ideal/first', $type: 'ideal.idea', title: 'Simplify view registration', votes: 3, status: 'approved' },
  { $path: 'ideal/second', $type: 'ideal.idea', title: 'Auto-generate type names', votes: 1, status: 'new' },
] as NodeData[]);
