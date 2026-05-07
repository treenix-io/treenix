import { createNode } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryTree } from './index';
import { createRepathTree } from './repath';

describe('createRepathTree', () => {
  it('translates paths: local /mnt → remote /', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/docs/readme', 'doc', { title: 'Hello' }));

    const mounted = createRepathTree(inner, '/mnt', '/docs');
    const node = await mounted.get('/mnt/readme');

    assert.ok(node);
    assert.equal(node.$path, '/mnt/readme');
    assert.equal((node as any).title, 'Hello');
  });

  it('get returns undefined for missing nodes', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/');

    assert.equal(await mounted.get('/mnt/nope'), undefined);
  });

  it('set translates path to remote', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/data');

    await mounted.set(createNode('/mnt/item', 'doc', { x: 1 }));

    // Verify inner tree has it at remote path
    const stored = await inner.get('/data/item');
    assert.ok(stored);
    assert.equal(stored.$path, '/data/item');
    assert.equal((stored as any).x, 1);
  });

  it('getChildren remaps all child paths', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/a', 'doc'));
    await inner.set(createNode('/a/one', 'doc'));
    await inner.set(createNode('/a/two', 'doc'));

    const mounted = createRepathTree(inner, '/x', '/a');
    const { items } = await mounted.getChildren('/x');

    assert.equal(items.length, 2);
    const paths = items.map(n => n.$path).sort();
    assert.deepEqual(paths, ['/x/one', '/x/two']);
  });

  it('remove translates path', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data/tmp', 'doc'));

    const mounted = createRepathTree(inner, '/mnt', '/data');
    const removed = await mounted.remove('/mnt/tmp');

    assert.ok(removed);
    assert.equal(await inner.get('/data/tmp'), undefined);
  });

  it('handles root remoteBase', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/hello', 'doc'));

    const mounted = createRepathTree(inner, '/remote', '/');
    const node = await mounted.get('/remote/hello');

    assert.ok(node);
    assert.equal(node.$path, '/remote/hello');
  });

  it('handles mount at root', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/stuff/item', 'doc'));

    const mounted = createRepathTree(inner, '/', '/stuff');
    const node = await mounted.get('/item');

    assert.ok(node);
    assert.equal(node.$path, '/item');
  });

  it('R4-TREE-1: rejects path containing ..', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/data');
    await assert.rejects(() => mounted.get('/mnt/../etc'), /traversal|Invalid path/);
  });

  it('R4-TREE-1: rejects path outside localBase prefix', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/data');
    await assert.rejects(() => mounted.get('/other/x'), /not under localBase/);
  });

  it('R4-TREE-1: accepts exact localBase address (mount root)', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data', 'dir'));
    const mounted = createRepathTree(inner, '/mnt', '/data');
    const node = await mounted.get('/mnt');
    assert.ok(node);
  });
});
