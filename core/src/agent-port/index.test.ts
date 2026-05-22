import { registerType } from '#comp';
import { createNode, R, register, S, W } from '#core';
import { clearRegistry } from '#core/index.test';
import { executeAction } from '#server/actions';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AgentPort } from './index';

function registerAgentPortForTest() {
  registerType('t.agent.port', AgentPort);
  register('t.agent.port', 'schema', () => ({
    $id: 't.agent.port',
    type: 'object' as const,
    properties: {},
    methods: {
      approve: { arguments: [] },
      reset: { arguments: [] },
    },
  }));
}

function delayedSideEffectTree(inner: Tree): Tree {
  return {
    ...inner,
    async set(node, ctx) {
      if (node.$path.startsWith('/auth/users/agent:')) {
        await new Promise(resolve => setImmediate(resolve));
      }
      return inner.set(node, ctx);
    },
    async remove(path, ctx) {
      if (path.startsWith('/auth/users/agent:')) {
        await new Promise(resolve => setImmediate(resolve));
      }
      return inner.remove(path, ctx);
    },
  };
}

describe('AgentPort actions', () => {
  beforeEach(() => {
    clearRegistry();
    registerAgentPortForTest();
  });

  it('approve waits until the agent user is created', async () => {
    const inner = createMemoryTree();
    const tree = delayedSideEffectTree(inner);
    await inner.set({
      ...createNode('/agents/bot', 't.agent.port'),
      status: 'pending',
      pendingKey: 'k',
      $acl: [{ g: 'admins', p: R | W | S }],
    });

    await executeAction(tree, '/agents/bot', undefined, undefined, 'approve');

    const user = await inner.get('/auth/users/agent:/agents/bot');
    assert.equal(user?.$type, 'user');
    assert.deepEqual((user as any).groups.list, ['agent']);
  });

  it('reset waits until the agent user is removed', async () => {
    const inner = createMemoryTree();
    const tree = delayedSideEffectTree(inner);
    await inner.set({
      ...createNode('/agents/bot', 't.agent.port'),
      status: 'approved',
      approvedKey: 'k',
      connected: true,
      connectedAt: 123,
      $acl: [{ g: 'u:agent:/agents/bot', p: R | W | S }],
    });
    await inner.set(createNode('/auth/users/agent:/agents/bot', 'user'));

    await executeAction(tree, '/agents/bot', undefined, undefined, 'reset');

    assert.equal(await inner.get('/auth/users/agent:/agents/bot'), undefined);
  });
});
