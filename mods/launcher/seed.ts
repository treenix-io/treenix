// Launcher seed — demo home screen with app shortcuts

import { registerPrefab } from '@treenx/core/mod';

const layout = JSON.stringify([
  { i: 'board', x: 0, y: 0, w: 1, h: 1 },
  { i: 'todo', x: 1, y: 0, w: 1, h: 1 },
  { i: 'contact', x: 2, y: 0, w: 1, h: 1 },
  { i: 'docs', x: 3, y: 0, w: 1, h: 1 },
  { i: 'sys', x: 0, y: 1, w: 1, h: 1 },
  { i: 'whisper', x: 1, y: 1, w: 1, h: 1 },
  { i: 'sim', x: 2, y: 1, w: 1, h: 1 },
  { i: 'llm', x: 3, y: 1, w: 1, h: 1 },
  { i: 'board-widget', x: 0, y: 2, w: 2, h: 2 },
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
  { $path: 'launcher/todo', $type: 'ref', $ref: '/todo' },
  { $path: 'launcher/contact', $type: 'ref', $ref: '/cafe/contact' },
  { $path: 'launcher/docs', $type: 'ref', $ref: '/docs' },
  { $path: 'launcher/sys', $type: 'ref', $ref: '/sys' },
  { $path: 'launcher/whisper', $type: 'ref', $ref: '/whisper' },
  { $path: 'launcher/sim', $type: 'ref', $ref: '/sim' },
  { $path: 'launcher/llm', $type: 'ref', $ref: '/sys/llm' },

  // Widgets (larger)
  { $path: 'launcher/board-widget', $type: 'ref', $ref: '/board' },
]);
