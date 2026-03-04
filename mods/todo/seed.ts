import { type NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('todo', 'seed', [
  { $path: 'todo', $type: 'dir' },
  { $path: 'todo/list', $type: 'todo.list', title: 'My Todos' },
  { $path: 'todo/list/1', $type: 'todo.item', title: 'Read the quickstart', done: true },
  { $path: 'todo/list/2', $type: 'todo.item', title: 'Build something', done: false },
] as NodeData[]);
