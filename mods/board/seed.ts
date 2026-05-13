// Board seed — kanban at /board, typed columns with query mounts

import { registerPrefab } from '@treenx/core/mod';

registerPrefab('board', 'seed', [
  { $path: 'board', $type: 'board.kanban' },
  { $path: 'board/data', $type: 'dir' },

  // Typed columns — each is a board.column + query mount
  { $path: 'board/backlog', $type: 'board.column', label: 'Backlog', color: 'border-border', order: 0,
    mount: { $type: 't.mount.query', source: '/board/data', match: { status: 'backlog' } } },
  { $path: 'board/todo', $type: 'board.column', label: 'To Do', color: 'border-blue-400', order: 1,
    mount: { $type: 't.mount.query', source: '/board/data', match: { status: 'todo' } } },
  { $path: 'board/doing', $type: 'board.column', label: 'In Progress', color: 'border-yellow-400', order: 2,
    mount: { $type: 't.mount.query', source: '/board/data', match: { status: 'doing' } } },
  { $path: 'board/review', $type: 'board.column', label: 'Review', color: 'border-purple-400', order: 3,
    mount: { $type: 't.mount.query', source: '/board/data', match: { status: 'review' } } },
  { $path: 'board/done', $type: 'board.column', label: 'Done', color: 'border-green-400', order: 4,
    mount: { $type: 't.mount.query', source: '/board/data', match: { status: 'done' } } },
], undefined, { tier: 'core' });
