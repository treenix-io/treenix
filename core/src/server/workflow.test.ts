import { registerType } from '#comp';
import { createNode } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { withMounts } from './mount';
import { createTreeRouter } from './trpc';
import { createWatchManager } from './watch';

class Order {
  status = 'new';
  
  cook() {
    this.status = 'kitchen';
  }
}

describe('Workflow & Spatial Gravity', () => {
  let rootStore: Tree;
  let trpcStore: Tree;

  beforeEach(async () => {
    clearRegistry();
    // We register the query mount manually or import it
    await import('./mount-adapters');
    registerType('order', Order);
    rootStore = createMemoryTree();
    trpcStore = withMounts(rootStore);
  });

  it('moves order from new to kitchen seamlessly with Immer patch', async () => {
    // 0. Setup root ACL
    await trpcStore.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: 15 }]
    });

    // 1. Setup flat data folder
    await trpcStore.set(createNode('/entities/orders/1', 'order', { status: 'new' }));

    // 2. Setup query mounts
    await trpcStore.set(
      createNode('/workflows/new', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/orders', match: { status: 'new' } }
      })
    );
    await trpcStore.set(
      createNode('/workflows/kitchen', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/orders', match: { status: 'kitchen' } }
      })
    );

    // Initial check
    let newFolder = await trpcStore.getChildren('/workflows/new');
    let kitchenFolder = await trpcStore.getChildren('/workflows/kitchen');
    assert.equal(newFolder.items.length, 1);
    assert.equal(kitchenFolder.items.length, 0);

    // Create tRPC router
    const watcher = createWatchManager();
    const router = createTreeRouter(trpcStore as any, watcher);
    const caller = router.createCaller({ session: null, token: null });

    // Execute the action (should emit patches in console and update DB)
    await caller.execute({
      path: '/entities/orders/1',
      action: 'cook',
    });

    // Check spatial gravity (moved via query mounts)
    newFolder = await trpcStore.getChildren('/workflows/new');
    kitchenFolder = await trpcStore.getChildren('/workflows/kitchen');
    
    assert.equal(newFolder.items.length, 0, 'Order should leave /workflows/new');
    assert.equal(kitchenFolder.items.length, 1, 'Order should appear in /workflows/kitchen');
    assert.equal(kitchenFolder.items[0].$path, '/entities/orders/1', 'Order path remains canonical');
    assert.equal(kitchenFolder.items[0].status, 'kitchen', 'Status is updated');
  });
});
