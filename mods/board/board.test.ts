// Board task tests — status flow, actions, field updates

import { type NodeData, resolve } from '@treenx/core';
import './types';
import { createMemoryTree } from '@treenx/core/tree';
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

async function execAction(tree: ReturnType<typeof createMemoryTree>, path: string, action: string, data?: unknown) {
  const handler = resolve('board.task', `action:${action}`) as any;
  assert.ok(handler, `action:${action} must be registered`);
  const node = await tree.get(path);
  assert.ok(node, `node at ${path} must exist`);
  await handler({ node, comp: node, tree, signal: AbortSignal.timeout(5000) }, data);
  await tree.set(node);
  return node;
}

describe('board.task registration', () => {
  it('registers all expected actions', () => {
    const actions = ['assign', 'start', 'submit', 'approve', 'reject', 'reopen', 'move'];
    for (const action of actions) {
      assert.ok(resolve('board.task', `action:${action}`), `action:${action} should be registered`);
    }
  });
});

describe('board.task.assign', () => {
  it('sets assignee and moves to todo', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask());

    const node = await execAction(tree, '/board/data/t-1', 'assign', { to: 'alice' });
    assert.equal(node.assignee, 'alice');
    assert.equal(node.status, 'todo');
    assert.ok((node.updatedAt as number) > 0);
  });

  it('trims whitespace from assignee', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask());

    const node = await execAction(tree, '/board/data/t-1', 'assign', { to: '  bob  ' });
    assert.equal(node.assignee, 'bob');
  });

  it('throws on empty assignee', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask());

    await assert.rejects(
      () => execAction(tree, '/board/data/t-1', 'assign', { to: '' }),
      (err: Error) => err.message.includes('assignee'),
    );
  });
});

describe('board.task.start', () => {
  it('moves from backlog to doing', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'backlog' }));

    const node = await execAction(tree, '/board/data/t-1', 'start');
    assert.equal(node.status, 'doing');
  });

  it('moves from todo to doing', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'todo' }));

    const node = await execAction(tree, '/board/data/t-1', 'start');
    assert.equal(node.status, 'doing');
  });

  it('throws from review', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'review' }));

    await assert.rejects(
      () => execAction(tree, '/board/data/t-1', 'start'),
      (err: Error) => err.message.includes('review'),
    );
  });
});

describe('board.task.submit', () => {
  it('moves from doing to review', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'doing' }));

    const node = await execAction(tree, '/board/data/t-1', 'submit');
    assert.equal(node.status, 'review');
  });

  it('stores result in result field', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'doing' }));

    const node = await execAction(tree, '/board/data/t-1', 'submit', { result: 'done it' });
    assert.equal(node.result, 'done it');
  });

  it('throws from backlog', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'backlog' }));

    await assert.rejects(
      () => execAction(tree, '/board/data/t-1', 'submit'),
      (err: Error) => err.message.includes('backlog'),
    );
  });
});

describe('board.task.approve', () => {
  it('moves from review to done', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'review' }));

    const node = await execAction(tree, '/board/data/t-1', 'approve');
    assert.equal(node.status, 'done');
  });

  it('throws from doing', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'doing' }));

    await assert.rejects(
      () => execAction(tree, '/board/data/t-1', 'approve'),
      (err: Error) => err.message.includes('doing'),
    );
  });
});

describe('board.task.reject', () => {
  it('moves from review back to doing', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'review' }));

    const node = await execAction(tree, '/board/data/t-1', 'reject');
    assert.equal(node.status, 'doing');
  });

  it('stores rejection reason in result', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'review' }));

    const node = await execAction(tree, '/board/data/t-1', 'reject', { reason: 'needs tests' });
    assert.ok((node.result as string).includes('needs tests'));
  });

  it('throws from backlog', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'backlog' }));

    await assert.rejects(
      () => execAction(tree, '/board/data/t-1', 'reject'),
      (err: Error) => err.message.includes('backlog'),
    );
  });
});

describe('board.task.reopen', () => {
  it('resets to backlog, clears assignee and result', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'done', assignee: 'alice', result: 'old result' }));

    const node = await execAction(tree, '/board/data/t-1', 'reopen');
    assert.equal(node.status, 'backlog');
    assert.equal(node.assignee, '');
    assert.equal(node.result, '');
    assert.ok((node.updatedAt as number) > 0);
  });
});

describe('board.task.move', () => {
  it('moves to a standard status', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'backlog' }));

    const node = await execAction(tree, '/board/data/t-1', 'move', { status: 'doing' });
    assert.equal(node.status, 'doing');
    assert.ok((node.updatedAt as number) > 0);
  });

  it('moves to a custom status string', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'backlog' }));

    const node = await execAction(tree, '/board/data/t-1', 'move', { status: 'blocked' });
    assert.equal(node.status, 'blocked');
  });

  it('no-ops when target equals current status', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask({ status: 'doing', updatedAt: 0 }));

    const node = await execAction(tree, '/board/data/t-1', 'move', { status: 'doing' });
    assert.equal(node.updatedAt, 0);
  });
});

describe('board.task full lifecycle', () => {
  it('backlog → assign → start → submit → approve', async () => {
    const tree = createMemoryTree();
    await tree.set(makeTask());

    await execAction(tree, '/board/data/t-1', 'assign', { to: 'ai-agent' });
    const a1 = await tree.get('/board/data/t-1');
    assert.equal(a1?.status, 'todo');

    await execAction(tree, '/board/data/t-1', 'start');
    const a2 = await tree.get('/board/data/t-1');
    assert.equal(a2?.status, 'doing');

    await execAction(tree, '/board/data/t-1', 'submit', { result: 'implemented' });
    const a3 = await tree.get('/board/data/t-1');
    assert.equal(a3?.status, 'review');
    assert.equal(a3?.result, 'implemented');

    await execAction(tree, '/board/data/t-1', 'approve');
    const a4 = await tree.get('/board/data/t-1');
    assert.equal(a4?.status, 'done');
  });
});
