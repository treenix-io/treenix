import type { NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getNamedComponents } from './named-components';

describe('getNamedComponents', () => {
  it('returns sibling components, dropping the node-level component', () => {
    const node = {
      $path: '/board/data/t-1',
      $type: 'board.task',
      title: 'Task',
      chat: { $type: 'metatron.chat', title: 'Chat' },
      plan: { $type: 'ai.plan', summary: 'Plan' },
      taskRef: '/agents/task-1',
    } as NodeData;

    const entries = getNamedComponents(node);

    assert.deepEqual(entries.map(([key]) => key), ['chat', 'plan']);
  });

  it('returns empty when node has no named component fields', () => {
    const node = {
      $path: '/board/data/solo',
      $type: 'board.task',
      title: 'Solo task',
    } as NodeData;

    assert.equal(getNamedComponents(node).length, 0);
  });
});
