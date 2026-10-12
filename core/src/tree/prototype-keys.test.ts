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
import type { Tree } from './index';

const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID';

const poisoned = (path: string): NodeData[] => [
  { $path: path, $type: 'dir', meta: { constructor: 'Foo' } },
  { $path: path, $type: 'dir', list: [JSON.parse('{"__proto__": {"polluted": true}}')] },
];

describe('prototype keys in written values', () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'treenix-proto-keys-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const listed = async (store: Tree) => (await store.getChildren('/docs')).items.map((n) => n.$path);
  const files = async () => (await readdir(join(dir, 'docs'))).sort();

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
