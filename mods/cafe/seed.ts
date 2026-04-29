import { type NodeData } from '@treenx/core';
import { registerPrefab } from '@treenx/core/mod';

registerPrefab('cafe', 'seed', [
  { $path: 'cafe', $type: 'dir' },
  { $path: 'cafe/contact', $type: 'cafe.contact', recipient: 'owner@cafe.example' },
  { $path: 'cafe/pages', $type: 'dir' },
] as NodeData[]);
