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

  it('frozen parents keep their mutable children protected', () => {
    const inner = { n: 1 };
    const ro = readonlyProxy(Object.freeze({ inner }));
    assert.notEqual(ro.inner, inner);
    assert.throws(() => { ro.inner.n = 2; }, isKindViolation);
    assert.equal(Object.getOwnPropertyDescriptor(ro, 'inner')?.value, ro.inner);
    assert.deepEqual(Object.keys(ro), ['inner']);
    assert.equal(inner.n, 1);
    assert.equal(Object.isExtensible(inner), true);
  });

  it('a locked object property keeps its mutable child protected', () => {
    const inner = { n: 1 };
    const target = { inner };
    Object.defineProperty(target, 'inner', { configurable: false, writable: false });
    const ro = readonlyProxy(target);

    assert.throws(() => { ro.inner.n = 2; }, isKindViolation);
    assert.deepEqual(ro, { inner: { n: 1 } });
    assert.equal(inner.n, 1);
  });

  it('frozen arrays retain their length, reflection and iteration with protected children', () => {
    const inner = { n: 1 };
    const ro = readonlyProxy(Object.freeze([inner]));

    assert.equal(Array.isArray(ro), true);
    assert.equal(ro.length, 1);
    assert.equal(Object.getOwnPropertyDescriptor(ro, 'length')?.value, 1);
    assert.deepEqual(Reflect.ownKeys(ro), ['0', 'length']);
    assert.deepEqual([...ro].map(value => value.n), [1]);
    assert.equal(JSON.stringify(ro), '[{"n":1}]');
    assert.throws(() => { ro[0].n = 2; }, isKindViolation);
    assert.equal(inner.n, 1);
  });
});
