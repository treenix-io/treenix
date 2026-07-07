// resolveRef id-first + tombstone chains (core-gk8.10 stage 2).
// Raw memory tree: ids are set explicitly per test — pipeline echo/mint
// semantics are covered in policy.test.ts / move.test.ts.

import { createNode, type NodeData } from '#core';
import { OpError } from '#errors';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryTree, followMoved, resolveRef, type Tree } from './index';

const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

function stone(path: string, to: string, id?: string): NodeData {
  const s: NodeData = { $path: path, $type: 'moved', $ref: to };
  if (id) s.$id = id;
  return s;
}

function refNode(path: string, to: string, refId?: string): NodeData {
  const r: NodeData = { $path: path, $type: 'ref', $ref: to };
  if (refId) r.$refId = refId;
  return r;
}

describe('resolveRef (id-first, core-gk8.10)', () => {
  it('non-ref node returns unchanged', async () => {
    const tree = createMemoryTree();
    const node = createNode('/a', 'doc', { n: 1 });
    assert.equal(await resolveRef(tree, node), node);
  });

  it('plain path ref resolves', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', { n: 1 }));
    const target = await resolveRef(tree, refNode('/r', '/a'));
    assert.equal(target.$path, '/a');
  });

  it('missing target throws NOT_FOUND', async () => {
    const tree = createMemoryTree();
    await assert.rejects(() => resolveRef(tree, refNode('/r', '/gone')), isCode('NOT_FOUND'));
  });

  it('follows a tombstone to the live node', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b', 'X'));
    await tree.set({ ...createNode('/b', 'doc', { n: 1 }), $id: 'X' });

    const target = await resolveRef(tree, refNode('/r', '/a', 'X'));
    assert.equal(target.$path, '/b');
    assert.equal(target.$id, 'X');
  });

  it('follows a chain of tombstones', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b', 'X'));
    await tree.set(stone('/b', '/c', 'X'));
    await tree.set({ ...createNode('/c', 'doc', {}), $id: 'X' });

    const target = await resolveRef(tree, refNode('/r', '/a', 'X'));
    assert.equal(target.$path, '/c');
  });

  it('tombstone cycle throws BAD_REQUEST', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b'));
    await tree.set(stone('/b', '/a'));
    await assert.rejects(() => resolveRef(tree, refNode('/r', '/a')), isCode('BAD_REQUEST'));
  });

  it('chain beyond the hop limit throws BAD_REQUEST', async () => {
    const tree = createMemoryTree();
    for (let i = 0; i < 10; i++) await tree.set(stone(`/n${i}`, `/n${i + 1}`));
    await tree.set(createNode('/n10', 'doc', {}));
    await assert.rejects(() => resolveRef(tree, refNode('/r', '/n0')), isCode('BAD_REQUEST'));
  });

  it('identity mismatch at the target throws NOT_FOUND (path reused)', async () => {
    const tree = createMemoryTree();
    await tree.set({ ...createNode('/a', 'doc', {}), $id: 'OTHER' });
    await assert.rejects(() => resolveRef(tree, refNode('/r', '/a', 'X')), isCode('NOT_FOUND'));
  });

  it('identity mismatch at a tombstone throws NOT_FOUND (foreign chain)', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b', 'OTHER'));
    await tree.set({ ...createNode('/b', 'doc', {}), $id: 'OTHER' });
    await assert.rejects(() => resolveRef(tree, refNode('/r', '/a', 'X')), isCode('NOT_FOUND'));
  });

  it('id-less target resolves for an id-carrying ref (legacy/virtual target)', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', {}));
    const target = await resolveRef(tree, refNode('/r', '/a', 'X'));
    assert.equal(target.$path, '/a');
  });

  it('self-repair: collapses the chain and adopts $refId on a stored ref node', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b', 'X'));
    await tree.set({ ...createNode('/b', 'doc', {}), $id: 'X' });
    await tree.set(refNode('/r', '/a'));

    const stored = await tree.get('/r');
    assert.ok(stored);
    const target = await resolveRef(tree, stored);
    assert.equal(target.$path, '/b');

    const repaired = await tree.get('/r');
    assert.equal(repaired?.$ref, '/b');
    assert.equal(repaired?.$refId, 'X');

    // Second resolve goes direct — no chain, no further writes.
    const rev = repaired?.$rev;
    assert.equal((await resolveRef(tree, repaired!)).$path, '/b');
    assert.equal((await tree.get('/r'))?.$rev, rev);
  });

  it('lazy adoption: direct hit still adopts $refId (path-ref corpus migration)', async () => {
    const tree = createMemoryTree();
    await tree.set({ ...createNode('/a', 'doc', {}), $id: 'X' });
    await tree.set(refNode('/r', '/a'));

    const stored = await tree.get('/r');
    await resolveRef(tree, stored!);
    assert.equal((await tree.get('/r'))?.$refId, 'X');
  });

  it('embedded ref (no $path) resolves without a repair write', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b', 'X'));
    await tree.set({ ...createNode('/b', 'doc', {}), $id: 'X' });

    let patched = 0;
    const spy: Tree = { ...tree, patch: async (p, o, c) => { patched++; return tree.patch(p, o, c); } };
    const target = await resolveRef(spy, { $ref: '/a' });
    assert.equal(target.$path, '/b');
    assert.equal(patched, 0);
  });

  it('repair failure does not fail the resolution', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b', 'X'));
    await tree.set({ ...createNode('/b', 'doc', {}), $id: 'X' });
    await tree.set(refNode('/r', '/a'));

    const readonly: Tree = { ...tree, patch: async () => { throw new OpError('FORBIDDEN', 'read-only'); } };
    const stored = await tree.get('/r');
    const target = await resolveRef(readonly, stored!);
    assert.equal(target.$path, '/b');
    assert.equal((await tree.get('/r'))?.$ref, '/a', 'unrepaired');
  });
});

describe('followMoved', () => {
  it('returns undefined target and zero hops for a missing path', async () => {
    const tree = createMemoryTree();
    const { target, hops } = await followMoved(tree, '/gone');
    assert.equal(target, undefined);
    assert.equal(hops, 0);
  });

  it('counts hops through the chain', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/b'));
    await tree.set(stone('/b', '/c'));
    await tree.set(createNode('/c', 'doc', {}));

    const { target, hops } = await followMoved(tree, '/a');
    assert.equal(target?.$path, '/c');
    assert.equal(hops, 2);
  });

  it('chain ending on a missing path returns undefined with hops counted', async () => {
    const tree = createMemoryTree();
    await tree.set(stone('/a', '/gone'));
    const { target, hops } = await followMoved(tree, '/a');
    assert.equal(target, undefined);
    assert.equal(hops, 1);
  });
});
