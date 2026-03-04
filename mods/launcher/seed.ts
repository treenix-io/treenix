// Launcher seed — demo home screen with app shortcuts

import type { NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';

const layout = JSON.stringify([
  { i: 'board', x: 0, y: 0, w: 1, h: 1 },
  { i: 'tasks', x: 1, y: 0, w: 1, h: 1 },
  { i: 'todo', x: 2, y: 0, w: 1, h: 1 },
  { i: 'landing', x: 3, y: 0, w: 1, h: 1 },
  { i: 'cafe', x: 0, y: 1, w: 1, h: 1 },
  { i: 'cosmos', x: 1, y: 1, w: 1, h: 1 },
  { i: 'docs', x: 2, y: 1, w: 1, h: 1 },
  { i: 'brahman', x: 3, y: 1, w: 1, h: 1 },
  { i: 'board-widget', x: 0, y: 2, w: 2, h: 2 },
  { i: 'sensors', x: 2, y: 2, w: 2, h: 1 },
]);

registerPrefab('launcher', 'seed', [
  {
    $path: 'launcher',
    $type: 'launcher',
    columns: 4,
    wallpaper: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
    layout,
  },

  // App icons (1×1)
  { $path: 'launcher/board', $type: 'ref', $ref: '/board' },
  { $path: 'launcher/tasks', $type: 'ref', $ref: '/tasks' },
  { $path: 'launcher/todo', $type: 'ref', $ref: '/todo' },
  { $path: 'launcher/landing', $type: 'ref', $ref: '/demo/landing' },
  { $path: 'launcher/cafe', $type: 'ref', $ref: '/cafe' },
  { $path: 'launcher/cosmos', $type: 'ref', $ref: '/cosmos' },
  { $path: 'launcher/docs', $type: 'ref', $ref: '/docs' },
  { $path: 'launcher/brahman', $type: 'ref', $ref: '/brahman' },

  // Widgets (larger)
  { $path: 'launcher/board-widget', $type: 'ref', $ref: '/board' },
  { $path: 'launcher/sensors', $type: 'ref', $ref: '/demo/sensors' },
] as NodeData[]);
