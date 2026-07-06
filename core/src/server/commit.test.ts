import { createNode } from '#core';
import { OpError } from '#errors';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commit, mutationLock } from './commit';

describe('commit envelope (core-gk8.15)', () => {
  it('N=1 dispatches tree.patch and applies', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', { n: 1 }));

    await commit(tree, '/a', [{ path: '/a', ops: [['r', 'n', 2]] }]);

    assert.equal((await tree.get('/a'))?.n, 2);
  });

  it('N=1 maps a failing test op to CONFLICT', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', { n: 1 }));

    await assert.rejects(
      () => commit(tree, '/a', [{ path: '/a', ops: [['t', '$rev', 999], ['r', 'n', 2]] }]),
      (e: unknown) => e instanceof OpError && e.code === 'CONFLICT',
    );
    assert.equal((await tree.get('/a'))?.n, 1, 'nothing applied');
  });

  it('N>1 dispatches patchMany: all-or-nothing', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/x/a', 'doc', { n: 1 }));
    await tree.set(createNode('/x/b', 'doc', { n: 1 }));

    await commit(tree, '/x', [
      { path: '/x/a', ops: [['r', 'n', 2]] },
      { path: '/x/b', ops: [['r', 'n', 2]] },
    ]);
    assert.equal((await tree.get('/x/a'))?.n, 2);
    assert.equal((await tree.get('/x/b'))?.n, 2);

    await assert.rejects(
      () => commit(tree, '/x', [
        { path: '/x/a', ops: [['r', 'n', 3]] },
        { path: '/x/b', ops: [['t', '$rev', 999], ['r', 'n', 3]] },
      ]),
      (e: unknown) => e instanceof OpError && e.code === 'CONFLICT',
    );
    assert.equal((await tree.get('/x/a'))?.n, 2, 'member #1 untouched after batch denial');
  });

  it('N>1 without patchMany capability rejects BAD_REQUEST', async () => {
    const mem = createMemoryTree();
    await mem.set(createNode('/x/a', 'doc', {}));
    const { patchMany, ...noBatch } = mem;

    await assert.rejects(
      () => commit(noBatch, '/x', [
        { path: '/x/a', ops: [['r', 'n', 1]] },
        { path: '/x/b', ops: [['r', 'n', 1]] },
      ]),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('empty batch rejects BAD_REQUEST', async () => {
    await assert.rejects(
      () => commit(createMemoryTree(), '/x', []),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('reentrant: commit inside an enclosing mutationLock span does not deadlock', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', { n: 1 }));

    await mutationLock('/a', async () => {
      await commit(tree, '/a', [{ path: '/a', ops: [['r', 'n', 2]] }]);
    });

    assert.equal((await tree.get('/a'))?.n, 2);
  });

  it('concurrent overlapping batches both complete (sorted acquisition, no deadlock)', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/x/a', 'doc', { n: 0 }));
    await tree.set(createNode('/x/b', 'doc', { n: 0 }));

    // Opposite entry orders — internal sort makes lock order identical.
    await Promise.all([
      commit(tree, '/x', [
        { path: '/x/a', ops: [['r', 'n', 1]] },
        { path: '/x/b', ops: [['r', 'n', 1]] },
      ]),
      commit(tree, '/x', [
        { path: '/x/b', ops: [['r', 'm', 1]] },
        { path: '/x/a', ops: [['r', 'm', 1]] },
      ]),
    ]);

    const a = await tree.get('/x/a');
    const b = await tree.get('/x/b');
    assert.equal(a?.n, 1); assert.equal(a?.m, 1);
    assert.equal(b?.n, 1); assert.equal(b?.m, 1);
  });
});
