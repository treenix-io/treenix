import { createNode, type NodeData } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryTree } from './index';
import { createQueryTree, matchesFilter } from './query';

describe('matchesFilter', () => {
  it('matches dot-path values', () => {
    const node = { $path: '/a', $type: 'x', status: { $type: 'status', value: 'active' } } as NodeData;
    assert.equal(matchesFilter(node, { 'status.value': 'active' }), true);
    assert.equal(matchesFilter(node, { 'status.value': 'done' }), false);
  });

  it('matches top-level $type fields', () => {
    const node = { $path: '/a', $type: 'order' } as NodeData;
    assert.equal(matchesFilter(node, { $type: 'order' }), true);
    assert.equal(matchesFilter(node, { $type: 'item' }), false);
  });

  it('supports mongo operators ($gt, $in)', () => {
    const node = { $path: '/a', $type: 'x', count: 10 } as NodeData;
    assert.equal(matchesFilter(node, { count: { $gt: 5 } }), true);
    assert.equal(matchesFilter(node, { count: { $in: [10, 20] } }), true);
    assert.equal(matchesFilter(node, { count: { $lt: 5 } }), false);
  });

  it('returns false for missing paths', () => {
    const node = { $path: '/a', $type: 'x' } as NodeData;
    assert.equal(matchesFilter(node, { 'status.value': 'active' }), false);
  });

  it('empty match matches everything', () => {
    const node = { $path: '/a', $type: 'x' } as NodeData;
    assert.equal(matchesFilter(node, {}), true);
  });

  it('deep dot-path matching', () => {
    const node = { $path: '/a', $type: 'x', meta: { $type: 'meta', nested: { flag: true } } } as NodeData;
    assert.equal(matchesFilter(node, { 'meta.nested.flag': true }), true);
    assert.equal(matchesFilter(node, { 'meta.nested.flag': false }), false);
  });
});

describe('QueryStore', () => {
  it('getChildren filters by match criteria', async () => {
    const parent = createMemoryTree();
    await parent.set({ $path: '/orders/a', $type: 'order', status: { $type: 'status', value: 'incoming' } } as NodeData);
    await parent.set({ $path: '/orders/b', $type: 'order', status: { $type: 'status', value: 'kitchen' } } as NodeData);
    await parent.set({ $path: '/orders/c', $type: 'order', status: { $type: 'status', value: 'incoming' } } as NodeData);

    const qs = createQueryTree({ source: '/orders', match: { 'status.value': 'incoming' } }, parent);
    const result = await qs.getChildren('/orders/incoming');

    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map(n => n.$path).sort(), ['/orders/a', '/orders/c']);
  });

  it('paginates after filtering', async () => {
    const parent = createMemoryTree();
    for (let i = 0; i < 5; i++)
      await parent.set({ $path: `/items/${i}`, $type: 'item', status: { $type: 's', value: 'active' } } as NodeData);
    await parent.set({ $path: '/items/x', $type: 'item', status: { $type: 's', value: 'archived' } } as NodeData);

    const qs = createQueryTree({ source: '/items', match: { 'status.value': 'active' } }, parent);
    const page = await qs.getChildren('/view/active', { limit: 2 });

    assert.equal(page.items.length, 2);
    assert.equal(page.total, 5);
  });

  it('get delegates to parent store', async () => {
    const parent = createMemoryTree();
    await parent.set(createNode('/items/a', 'item'));

    const qs = createQueryTree({ source: '/items', match: {} }, parent);
    const node = await qs.get('/items/a');

    assert.equal(node?.$type, 't.item');
  });

  it('set delegates to parent store', async () => {
    const parent = createMemoryTree();
    const qs = createQueryTree({ source: '/items', match: {} }, parent);
    await qs.set(createNode('/items/new', 'item'));

    assert.equal((await parent.get('/items/new'))?.$type, 't.item');
  });

  it('remove delegates to parent store', async () => {
    const parent = createMemoryTree();
    await parent.set(createNode('/items/a', 'item'));

    const qs = createQueryTree({ source: '/items', match: {} }, parent);
    assert.equal(await qs.remove('/items/a'), true);
    assert.equal(await parent.get('/items/a'), undefined);
  });

  it('excludes non-matching nodes like mount configs', async () => {
    const parent = createMemoryTree();
    await parent.set({ $path: '/orders/a', $type: 'order', status: { $type: 's', value: 'new' } } as NodeData);
    await parent.set(createNode('/orders/incoming', 'mount-point')); // mount config — no status
    await parent.set(createNode('/orders/kanban', 'orders.kanban')); // view — no status

    const qs = createQueryTree({ source: '/orders', match: { 'status.value': 'new' } }, parent);
    const result = await qs.getChildren('/orders/incoming');

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].$path, '/orders/a');
  });
});
