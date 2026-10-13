// Board task tests — status flow, actions, field updates

import { getComponent, type NodeData, resolve } from '@treenx/core';
import './types';
import { Order } from './types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function makeTask(overrides?: Partial<NodeData>): NodeData {
  return {
    $path: '/board/data/t-1',
    $type: 'board.task',
    title: 'Test task',
    description: '',
    status: 'backlog',
    assignee: '',
    priority: 'normal',
    result: '',
    createdAt: Date.now(),
    updatedAt: 0,
    ...overrides,
  } as NodeData;
}

describe('board.task registration', () => {
  it('registers all expected actions', () => {
    const actions = ['assign', 'start', 'submit', 'approve', 'reject', 'reopen', 'move'];
    for (const action of actions) {
      assert.ok(resolve('board.task', `action:${action}`), `action:${action} should be registered`);
    }
  });
});

// Sort order = shared `board.order` component composed onto columns AND tasks.
// Regression guard for kanban drag-reorder: a card/column carries its position
// in a separate `#order` component, read back via getComponent(node, Order).
describe('board.order component', () => {
  it('is registered as a component type', () => {
    assert.equal(resolve('board.order', 'class'), Order);
  });

  it('reads back the same component from a task and a column', () => {
    const task = makeTask({ '#order': { $type: 'board.order', order: 1.5 } } as Partial<NodeData>);
    const column: NodeData = {
      $path: '/board/todo', $type: 'board.column', label: 'To Do', color: 'border-border',
      '#order': { $type: 'board.order', order: 3 },
    } as NodeData;

    assert.equal(getComponent(task, Order)?.order, 1.5);
    assert.equal(getComponent(column, Order)?.order, 3);
  });

  it('missing component reads as undefined (caller applies its own fallback)', () => {
    assert.equal(getComponent(makeTask(), Order), undefined);
  });

  it('nodes sort by their fractional order', () => {
    const mk = (id: string, order: number): NodeData =>
      makeTask({ $path: `/board/data/${id}`, '#order': { $type: 'board.order', order } } as Partial<NodeData>);
    const nodes = [mk('c', 2), mk('a', 0.5), mk('b', 1)];
    const sorted = [...nodes].sort((x, y) => (getComponent(x, Order)?.order ?? 0) - (getComponent(y, Order)?.order ?? 0));
    assert.deepEqual(sorted.map((n) => n.$path.split('/').at(-1)), ['a', 'b', 'c']);
  });
});
