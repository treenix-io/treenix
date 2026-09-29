// wrapReadOnlyTree — forwards the full read surface (incl. scanChildren/watch),
// denies every mutation. Regression: hand-listing read methods previously
// dropped scanChildren, which would break the read runtime if this facade
// ever fed an asTreeSource.

import { KernelError } from '#errors';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readonlyProxy, wrapReadOnlyTree } from './readonly-tree';

const isKindViolation = (e: unknown): e is KernelError => e instanceof KernelError && e.code === 'FORBIDDEN';

describe('wrapReadOnlyTree', () => {
  it('forwards scanChildren so a read-only context can still traverse', async () => {
    const mem = createMemoryTree();
    await mem.set({ $path: '/data', $type: 'dir' });
    await mem.set({ $path: '/data/a', $type: 'thing' });
    const ro = wrapReadOnlyTree(mem);
    assert.ok(ro.scanChildren, 'read-only facade must forward scanChildren');
    const paths: string[] = [];
    for await (const e of ro.scanChildren!('/data')) paths.push(e.node.$path);
    assert.deepEqual(paths, ['/data/a']);
  });

  it('forwards watch when the inner tree exposes it', () => {
    const mem = createMemoryTree();
    const withWatch: Tree = { ...mem, watch: () => (async function* () {})() };
    assert.ok(wrapReadOnlyTree(withWatch).watch, 'read-only facade must forward watch');
  });

  it('denies set / patch / remove', () => {
    const ro = wrapReadOnlyTree(createMemoryTree());
    assert.throws(() => ro.set({ $path: '/x', $type: 'thing' }), isKindViolation);
    assert.throws(() => ro.patch('/x', []), isKindViolation);
    assert.throws(() => ro.remove('/x'), isKindViolation);
  });
});

// Handlers receive the node cache's live objects: a nested mutation through a
// shallow guard rewrote cached data other readers then saw, unpersisted.
describe('readonlyProxy', () => {
  const isKindViolation = (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN';

  it('guards nested objects and arrays, keeps reads and identity', () => {
    const live = { box: { list: ['a'], meta: { n: 1 } } };
    const ro = readonlyProxy(live);

    assert.throws(() => ro.box.list.push('phantom'), isKindViolation);
    assert.throws(() => { ro.box.meta.n = 2; }, isKindViolation);
    assert.throws(() => { delete (ro.box as { meta?: unknown }).meta; }, isKindViolation);
    assert.deepEqual(live, { box: { list: ['a'], meta: { n: 1 } } });

    assert.equal(ro.box, ro.box, 'stable identity');
    assert.deepEqual(ro.box.list.map(x => x.toUpperCase()), ['A']);
    assert.equal(JSON.stringify(ro), JSON.stringify(live));
  });

  it('frozen parents return their exact values (proxy invariant)', () => {
    const inner = { n: 1 };
    const ro = readonlyProxy(Object.freeze({ inner }));
    assert.equal(ro.inner, inner);
  });
});
