import type { NodeInput } from '@treenx/core/kernel/types';

/** Original todo seed data shared by both deployment paths. */
export const todoSeed = [
  { $path: 'todo', $type: 'dir' },
  { $path: 'todo/list', $type: 'todo.list', title: 'My Todos' },
  { $path: 'todo/list/1', $type: 'todo.item', title: 'Read the quickstart', done: true },
  { $path: 'todo/list/2', $type: 'todo.item', title: 'Build something', done: false },
] satisfies readonly NodeInput[];
