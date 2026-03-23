import { createNode, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import { createQueryTree } from '#tree/query';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { withMounts } from './mount';
import './mount-adapters'; // ensure registrations

describe('Parametrized Mounts', () => {
  let rootStore: Tree;
  let tree: Tree;

  beforeEach(() => {
    clearRegistry();
    // Direct registration for tests due to module caching issues
    register('t.mount.query', 'mount', (config, parentStore) => {
      const n = config as any;
      const query = n['query'] as { source: string; match: Record<string, unknown> } | undefined;
      return createQueryTree({ source: query!.source, match: query!.match }, parentStore);
    });
    rootStore = createMemoryTree();
    tree = withMounts(rootStore);
  });

  // TODO: parametrized mounts disabled — depth:5 scan removed, needs explicit registry
  it.todo('resolves parametrized mount correctly', async () => {
    await tree.set({ ...createNode('/', 'root') });
    await tree.set({ ...createNode('/users', 'folder') });
    
    // Flat data
    await tree.set({ ...createNode('/data/orders/1', 'order', { ownerId: 'alice' }) });
    await tree.set({ ...createNode('/data/orders/2', 'order', { ownerId: 'bob' }) });

    // Parametrized mount point
    await tree.set({
      ...createNode('/users/:userId/orders', 'folder', {}, {
        mount: { $type: 't.mount.query' },
        query: { $type: 'query', source: '/data/orders', match: { ownerId: ':userId' } } // the :userId should be bound
      })
    });

    // Check virtual folder for alice
    const aliceOrders = await tree.getChildren('/users/alice/orders', { depth: 1 });
    assert.equal(aliceOrders.items.length, 1);
    assert.equal(aliceOrders.items[0].$path, '/data/orders/1');

    // Check virtual folder for bob
    const bobOrders = await tree.getChildren('/users/bob/orders', { depth: 1 });
    assert.equal(bobOrders.items.length, 1);
    assert.equal(bobOrders.items[0].$path, '/data/orders/2');
  });
});
