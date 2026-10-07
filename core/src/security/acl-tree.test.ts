import assert from 'node:assert/strict';
import { it } from 'node:test';
import { R, W } from '#core';
import { createMemoryTree } from '#tree';
import { withAcl } from './acl-tree';

it('full-node ACL comparison propagates serialization failures before writing', async () => {
  const raw = createMemoryTree();
  await raw.set({ $path: '/', $type: 't.dir', $acl: [{ g: 'users', p: R | W }] });
  await raw.set({
    $path: '/item', $type: 't.dir', title: 'original',
    '#locked': { $type: 't.data', $acl: [{ g: 'users', p: R }], value: 1 },
  });
  const original = await raw.get('/item');
  assert.ok(original);
  const tree = withAcl(raw, 'user', ['users']);

  await assert.rejects(tree.set({
    ...original, title: 'changed',
    '#locked': { $type: 't.data', $acl: [{ g: 'users', p: R }], value: 1n },
  }), TypeError);
  assert.deepEqual(await raw.get('/item'), original);
});
