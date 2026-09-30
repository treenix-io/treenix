// A prototype key in a written node or op value is refused before any write: fs reads its files back with
// safeJsonParse, which throws on one, so a stored key made the node and every listing of its parent unreadable.

import { createNode, type NodeData } from '#core';
import { KernelError } from '#errors';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { createMemoryTree, type Tree } from './index';
import { withStoragePolicy } from './policy';

const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID';

const poisoned = (path: string): NodeData[] => [
  { $path: path, $type: 'dir', meta: { constructor: 'Foo' } },
  { $path: path, $type: 'dir', list: [JSON.parse('{"__proto__": {"polluted": true}}')] },
];

describe('prototype keys in written values', () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'treenix-proto-keys-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function setup() {
    const store = await createFsTree(dir);
    const policy = withStoragePolicy(store);
    await policy.tree.set(createNode('/docs', 'dir'));
    await policy.tree.set(createNode('/docs/ok', 'dir', { n: 1 }));
    return { store, writers: [policy.tree, policy.base] };
  }

  const listed = async (store: Tree) => (await store.getChildren('/docs')).items.map((n) => n.$path);
  const files = async () => (await readdir(join(dir, 'docs'))).sort();

  it('a set carrying one is refused on the client and system paths, and the folder still lists', async () => {
    const { store, writers } = await setup();

    for (const writer of writers)
      for (const node of poisoned('/docs/bad')) await assert.rejects(writer.set(node), isInvalid);

    assert.deepEqual(await files(), ['$.json', 'ok.json']);
    assert.deepEqual(await listed(store), ['/docs/ok']);
  });

  it('a patch writing one is refused on both paths and leaves the node as stored', async () => {
    const { store, writers } = await setup();
    const before = await store.get('/docs/ok');

    for (const writer of writers) {
      await assert.rejects(writer.patch('/docs/ok', [['r', 'n', { prototype: {} }]]), isInvalid);
      await assert.rejects(writer.patch('/docs/ok', [['a', 'tags', [JSON.parse('{"__proto__": {}}')]]]), isInvalid);
    }

    assert.deepEqual(await store.get('/docs/ok'), before);
  });

  it('a batch with one poisoned member writes none of its members', async () => {
    const { store, writers } = await setup();
    const before = await store.get('/docs/ok');

    for (const writer of writers) {
      await assert.rejects(writer.patchMany!('/docs', [
        { path: '/docs/ok', ops: [['r', 'n', 2]] },
        { path: '/docs/new', node: poisoned('/docs/new')[0] },
      ]), isInvalid);
      await assert.rejects(writer.patchMany!('/docs', [
        { path: '/docs/new', node: createNode('/docs/new', 'dir') },
        { path: '/docs/ok', ops: [['r', 'n', { constructor: 'x' }]] },
      ]), isInvalid);
    }

    assert.deepEqual(await store.get('/docs/ok'), before);
    assert.deepEqual(await listed(store), ['/docs/ok']);
  });

  it('the policy refuses them over a store that would keep them', async () => {
    const store = createMemoryTree();
    const { tree, base } = withStoragePolicy(store);
    await base.set(createNode('/docs/ok', 'dir', { n: 1 }));
    const before = await store.get('/docs/ok');

    for (const writer of [tree, base]) {
      await assert.rejects(writer.set(poisoned('/docs/bad')[0]), isInvalid);
      await assert.rejects(writer.patch('/docs/ok', [['r', 'n', { constructor: 'x' }]]), isInvalid);
      await assert.rejects(writer.patchMany!('/docs', [{ path: '/docs/ok', ops: [['r', 'n', { prototype: 1 }]] }]), isInvalid);
    }

    assert.deepEqual(await store.get('/docs/ok'), before);
    assert.equal(await store.get('/docs/bad'), undefined);
  });

  it('the fs store itself never writes a body it could not read back', async () => {
    const store = await createFsTree(dir);
    await store.set(createNode('/docs/ok', 'dir'));

    for (const node of poisoned('/docs/bad')) await assert.rejects(store.set(node));
    await assert.rejects(store.patchMany!('/docs', [
      { path: '/docs/a', node: createNode('/docs/a', 'dir') },
      { path: '/docs/b', node: poisoned('/docs/b')[1] },
    ]), isInvalid);

    assert.deepEqual(await files(), ['ok.json']);
    assert.deepEqual(await listed(store), ['/docs/ok']);
  });
});
