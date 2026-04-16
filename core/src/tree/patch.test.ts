import { createNode } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpError } from '#errors';
import { createMemoryTree } from './index';
import { applyOps, fromRfc6902, type PatchOp, PatchTestError, toRfc6902 } from './patch';

describe('applyOps', () => {
  it('replace shallow field', () => {
    const obj = { title: 'old', count: 1 };
    applyOps(obj, [['r', 'title', 'new']]);
    assert.equal(obj.title, 'new');
    assert.equal(obj.count, 1);
  });

  it('replace nested field via dot path', () => {
    const obj = { mesh: { width: 5, height: 10 } } as any;
    applyOps(obj, [['r', 'mesh.width', 20]]);
    assert.equal(obj.mesh.width, 20);
    assert.equal(obj.mesh.height, 10);
  });

  it('test passes on match', () => {
    const obj = { $rev: 3 };
    assert.doesNotThrow(() => applyOps(obj, [['t', '$rev', 3]]));
  });

  it('test throws PatchTestError on mismatch', () => {
    const obj = { $rev: 3 };
    assert.throws(
      () => applyOps(obj, [['t', '$rev', 5]]),
      (e: any) => e instanceof PatchTestError && e.code === 'TEST_FAILED',
    );
  });

  it('test + replace: atomic — test fails, replace not applied', () => {
    const obj = { $rev: 3, title: 'old' } as any;
    assert.throws(
      () => applyOps(obj, [['t', '$rev', 999], ['r', 'title', 'new']]),
      (e: any) => e instanceof PatchTestError,
    );
    assert.equal(obj.title, 'old');
  });

  it('add to array via .- suffix', () => {
    const obj = { tags: ['a', 'b'] } as any;
    applyOps(obj, [['a', 'tags.-', 'c']]);
    assert.deepEqual(obj.tags, ['a', 'b', 'c']);
  });

  it('add creates new field', () => {
    const obj = {} as any;
    applyOps(obj, [['a', 'newField', 42]]);
    assert.equal(obj.newField, 42);
  });

  it('delete removes field', () => {
    const obj = { title: 'x', obsolete: true } as any;
    applyOps(obj, [['d', 'obsolete']]);
    assert.equal(obj.title, 'x');
    assert.equal('obsolete' in obj, false);
  });

  it('delete nested field', () => {
    const obj = { meta: { a: 1, b: 2 } } as any;
    applyOps(obj, [['d', 'meta.b']]);
    assert.equal(obj.meta.a, 1);
    assert.equal('b' in obj.meta, false);
  });

  it('delete array item by index splices instead of nulling', () => {
    const obj = { items: ['a', 'b', 'c'] } as any;
    applyOps(obj, [['d', 'items.1']]);
    assert.deepEqual(obj.items, ['a', 'c']);
  });

  it('delete first array item', () => {
    const obj = { items: ['x', 'y'] } as any;
    applyOps(obj, [['d', 'items.0']]);
    assert.deepEqual(obj.items, ['y']);
  });

  it('delete nested array item', () => {
    const obj = { checklist: { items: ['do a', 'do b', 'do c'] } } as any;
    applyOps(obj, [['d', 'checklist.items.0']]);
    assert.deepEqual(obj.checklist.items, ['do b', 'do c']);
  });

  it('creates intermediate objects on set', () => {
    const obj = {} as any;
    applyOps(obj, [['r', 'deep.nested.field', 'ok']]);
    assert.equal(obj.deep.nested.field, 'ok');
  });
});

describe('RFC 6902 conversion', () => {
  it('toRfc6902 round-trips', () => {
    const ops: PatchOp[] = [
      ['t', '$rev', 5],
      ['r', 'mesh.width', 20],
      ['a', 'tags.-', 'x'],
      ['d', 'obsolete'],
    ];
    const rfc = toRfc6902(ops);
    assert.deepEqual(rfc, [
      { op: 'test', path: '/$rev', value: 5 },
      { op: 'replace', path: '/mesh/width', value: 20 },
      { op: 'add', path: '/tags/-', value: 'x' },
      { op: 'remove', path: '/obsolete' },
    ]);

    const back = fromRfc6902(rfc);
    assert.deepEqual(back, ops);
  });
});

describe('Tree.patch', () => {
  it('patches a node in memory tree', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'old', count: 1 }));

    await tree.patch('/n', [['r', 'title', 'new'], ['r', 'count', 2]]);

    const result = (await tree.get('/n'))!;
    assert.equal(result.title, 'new');
    assert.equal(result.count, 2);
  });

  it('bumps $rev on patch', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'x' }));
    const rev1 = (await tree.get('/n'))!.$rev!;

    await tree.patch('/n', [['r', 'title', 'y']]);
    const rev2 = (await tree.get('/n'))!.$rev!;
    assert.equal(rev2, rev1 + 1);
  });

  it('OCC via test op', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'x' }));
    const rev = (await tree.get('/n'))!.$rev!;

    // Correct rev — should succeed
    await tree.patch('/n', [['t', '$rev', rev], ['r', 'title', 'y']]);
    assert.equal((await tree.get('/n'))!.title, 'y');

    // Stale rev — should fail
    await assert.rejects(
      () => tree.patch('/n', [['t', '$rev', rev], ['r', 'title', 'z']]),
      (e: any) => e instanceof PatchTestError,
    );
    // Value unchanged after failed patch
    assert.equal((await tree.get('/n'))!.title, 'y');
  });

  it('throws OpError NOT_FOUND on missing node', async () => {
    const tree = createMemoryTree();
    await assert.rejects(
      () => tree.patch('/nonexistent', [['r', 'x', 1]]),
      (e: unknown) => e instanceof OpError && e.code === 'NOT_FOUND',
    );
  });

  it('preserves $type and $path', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'x' }));

    await tree.patch('/n', [['r', 'title', 'y']]);

    const result = (await tree.get('/n'))!;
    assert.equal(result.$type, 't.mytype');
    assert.equal(result.$path, '/n');
  });

  it('nested field patch', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', {
      mesh: { $type: 't3d.mesh', width: 5, height: 10 },
    }));

    await tree.patch('/n', [['r', 'mesh.width', 20]]);

    const result = (await tree.get('/n'))!;
    const mesh = result.mesh as any;
    assert.equal(mesh.width, 20);
    assert.equal(mesh.height, 10);
    assert.equal(mesh.$type, 't3d.mesh');
  });

  it('add to array', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { tags: ['a', 'b'] }));

    await tree.patch('/n', [['a', 'tags.-', 'c']]);

    const result = (await tree.get('/n'))!;
    assert.deepEqual(result.tags, ['a', 'b', 'c']);
  });

  it('delete field', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype', { title: 'x', obsolete: true }));

    await tree.patch('/n', [['d', 'obsolete']]);

    const result = (await tree.get('/n'))!;
    assert.equal(result.title, 'x');
    assert.equal('obsolete' in result, false);
  });
});
