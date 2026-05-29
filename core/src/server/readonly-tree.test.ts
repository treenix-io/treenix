// wrapReadOnlyTree — forwards the full read surface (incl. scanChildren/watch),
// denies every mutation. Regression: hand-listing read methods previously
// dropped scanChildren, which would break the read runtime if this facade
// ever fed an asTreeSource.

import { OpError } from '#errors';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapReadOnlyTree } from './readonly-tree';

const isKindViolation = (e: unknown): e is OpError => e instanceof OpError && e.code === 'KIND_VIOLATION';

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
