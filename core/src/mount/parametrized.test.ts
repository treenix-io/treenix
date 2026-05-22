// Parametrized mounts — disabled (depth:5 scan removed, needs explicit registry)
// Re-enable when parametrized mount resolution is implemented.

// import { createNode, register } from '#core';
// import { clearRegistry } from '#core/index.test';
// import { createMemoryTree, type Tree } from '#tree';
// import { createQueryTree } from '#tree/query';
// import assert from 'node:assert/strict';
// import { beforeEach, describe, it } from 'node:test';
// import { withMounts } from './index';
// import { MountQuery } from './adapters';
//
// describe('Parametrized Mounts', () => {
//   let rootStore: Tree;
//   let tree: Tree;
//
//   beforeEach(() => {
//     clearRegistry();
//     register(MountQuery, 'mount', (mount, ctx) => {
//       if (!mount.source || !mount.match) throw new Error('t.mount.query: source and match required');
//       return createQueryTree(mount, ctx.globalStore || ctx.parentStore);
//     });
//     rootStore = createMemoryTree();
//     tree = withMounts(rootStore);
//   });
//
//   it('resolves parametrized mount correctly', async () => {
//     await tree.set({ ...createNode('/', 'root') });
//     await tree.set({ ...createNode('/users', 'folder') });
//     await tree.set({ ...createNode('/data/orders/1', 'order', { ownerId: 'alice' }) });
//     await tree.set({ ...createNode('/data/orders/2', 'order', { ownerId: 'bob' }) });
//     await tree.set({
//       ...createNode('/users/:userId/orders', 'folder', {}, {
//         mount: { $type: 't.mount.query', source: '/data/orders', match: { ownerId: ':userId' } }
//       })
//     });
//     const aliceOrders = await tree.getChildren('/users/alice/orders', { depth: 1 });
//     assert.equal(aliceOrders.items.length, 1);
//     const bobOrders = await tree.getChildren('/users/bob/orders', { depth: 1 });
//     assert.equal(bobOrders.items.length, 1);
//   });
// });
