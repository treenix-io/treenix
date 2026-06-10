import { createNode } from '@treenx/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getNamedComponents } from './named-components';

describe('getNamedComponents', () => {
  it('returns sibling components, dropping the node-level component', () => {
    const node = createNode('/board/data/t-1', 'board.task', {
      title: 'Task',
      taskRef: '/agents/task-1',
    }, {
      chat: { $type: 'metatron.chat', title: 'Chat' },
      plan: { $type: 'ai.plan', summary: 'Plan' },
    });

    const entries = getNamedComponents(node);

    // getComponents returns ACTUAL storage keys — consumers index node[key].
    assert.deepEqual(entries.map(([key]) => key), ['#chat', '#plan']);
  });

  it('returns empty when node has no named component fields', () => {
    const node = createNode('/board/data/solo', 'board.task', { title: 'Solo task' });

    assert.equal(getNamedComponents(node).length, 0);
  });
});
