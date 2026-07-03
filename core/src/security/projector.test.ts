import { A, R, W, createNode, register, type ComponentData } from '#core';
import { clearRegistry } from '#testing';
import { OpError } from '#errors';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Actor, assertSourceReadable, createProjector } from './projector';

let tree: Tree;
const PUBLIC_ACTOR: Actor = { userId: null, claims: ['public'] };
const AUTH_ACTOR: Actor = { userId: 'alice', claims: ['authenticated', 'u:alice'] };

beforeEach(async () => {
  clearRegistry();
  tree = createMemoryTree();
  await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }] });
});

describe('createProjector', () => {
  it('returns node verbatim when actor has R but not A (strips $acl/$owner)', async () => {
    await tree.set({
      ...createNode('/x', 'item'),
      $acl: [{ g: 'public', p: R }],
      $owner: 'someone',
    });
    const node = await tree.get('/x');
    assert.ok(node);

    const project = createProjector(tree, PUBLIC_ACTOR);
    const visible = await project(node);
    assert.ok(visible);
    assert.equal(visible.$acl, undefined);
    assert.equal(visible.$owner, undefined);
    assert.equal(visible.$path, '/x');
    assert.equal(visible.$type, 't.item');
  });

  it('preserves $acl/$owner when actor has A', async () => {
    await tree.set({
      ...createNode('/x', 'item'),
      $acl: [{ g: 'public', p: R | W | A }],
      $owner: 'someone',
    });
    const node = await tree.get('/x');
    assert.ok(node);

    const project = createProjector(tree, PUBLIC_ACTOR);
    const visible = await project(node);
    assert.ok(visible);
    assert.deepEqual(visible.$acl, [{ g: 'public', p: R | W | A }]);
    assert.equal(visible.$owner, 'someone');
  });

  it('returns null when actor lacks R', async () => {
    await tree.set({
      ...createNode('/x', 'item'),
      $acl: [{ g: 'authenticated', p: R }, { g: 'public', p: 0 }],
    });
    const node = await tree.get('/x');
    assert.ok(node);

    const project = createProjector(tree, PUBLIC_ACTOR);
    const visible = await project(node);
    assert.equal(visible, null);
  });

  it('strips forbidden components', async () => {
    register('secret', 'acl', () => [{ g: 'admins', p: R }]);
    await tree.set({
      ...createNode('/x', 'item'),
      '#visible': { $type: 'visible-comp', text: 'ok' } as ComponentData,
      '#secret': { $type: 'secret', value: 'hidden' } as ComponentData,
      $acl: [{ g: 'public', p: R }],
    });
    const node = await tree.get('/x');
    assert.ok(node);

    const project = createProjector(tree, PUBLIC_ACTOR);
    const visible = await project(node);
    assert.ok(visible);
    assert.ok(visible['#visible']);
    assert.equal(visible['#secret'], undefined);
  });

  it('caches per-path permission — same node twice skips re-resolution', async () => {
    await tree.set({ ...createNode('/x', 'item'), $acl: [{ g: 'public', p: R }] });
    const node = await tree.get('/x');
    assert.ok(node);

    let getCalls = 0;
    const wrappedTree: Tree = {
      ...tree,
      get(p, c) { getCalls++; return tree.get(p, c); },
    };
    const project = createProjector(wrappedTree, PUBLIC_ACTOR);

    await project(node);
    const callsAfterFirst = getCalls;
    await project(node);
    assert.equal(getCalls, callsAfterFirst, `second project() on same path must hit cache, ${getCalls - callsAfterFirst} extra gets`);
  });
});

describe('assertSourceReadable', () => {
  it('passes when actor has R on source', async () => {
    await tree.set({ ...createNode('/x', 'dir'), $acl: [{ g: 'public', p: R }] });
    await assertSourceReadable(tree, PUBLIC_ACTOR, '/x');
  });

  it('throws FORBIDDEN when actor lacks R', async () => {
    await tree.set({
      ...createNode('/x', 'dir'),
      $acl: [{ g: 'authenticated', p: R }, { g: 'public', p: 0 }],
    });
    await assert.rejects(
      () => assertSourceReadable(tree, PUBLIC_ACTOR, '/x'),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('passes for authenticated actor on auth-only source', async () => {
    await tree.set({
      ...createNode('/x', 'dir'),
      $acl: [{ g: 'authenticated', p: R }, { g: 'public', p: 0 }],
    });
    await assertSourceReadable(tree, AUTH_ACTOR, '/x');
  });
});
