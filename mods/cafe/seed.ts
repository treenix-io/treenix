import { type NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('cafe', 'seed', [
  { $path: 'cafe', $type: 'dir' },
  { $path: 'cafe/contact', $type: 'cafe.contact', recipient: 'owner@cafe.example' },
  { $path: 'cafe/pages', $type: 'dir' },
] as NodeData[]);
