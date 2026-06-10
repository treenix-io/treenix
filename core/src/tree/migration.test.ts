import { createNode, register, unregister } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { withMigration } from './migration';

const TEST_TYPE = 'test.migrated';
const COMP_TYPE = 'test.comp.migrated';
const UNREL_TYPE = 'test.unrelated-bump';

describe('withMigration', () => {
  afterEach(() => {
    for (const t of [TEST_TYPE, COMP_TYPE, UNREL_TYPE]) {
      try { unregister(t, 'migrate'); } catch { /* not registered in this test */ }
    }
  });

  it('passes through nodes without migrations', async () => {
    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', 'dir', { label: 'hi' }));

    const got = await tree.get('/a');
    assert.equal(got?.label, 'hi');
    assert.equal(got?.$v, undefined);
  });

  it('runs the migration ladder on read and stamps $v', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.items = Array.isArray(n.items) ? n.items : []; },
      2: (n: Record<string, unknown>) => { n.label ??= 'default'; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { items: 'old-string' }));

    const got = await tree.get('/a');
    assert.deepEqual(got?.items, []);
    assert.equal(got?.label, 'default');
    assert.equal(got?.$v, 2);
  });

  it('skips steps at or below the stored $v', async () => {
    let ran1 = 0;
    register(TEST_TYPE, 'migrate', () => ({
      1: () => { ran1++; },
      2: (n: Record<string, unknown>) => { n.upgraded = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    const node = createNode('/a', TEST_TYPE, {});
    node.$v = 1;
    await inner.set(node);

    const got = await tree.get('/a');
    assert.equal(ran1, 0);
    assert.equal(got?.upgraded, true);
    assert.equal(got?.$v, 2);
  });

  it('migrates # components by their own ladder; bare $type values are data and stay untouched', async () => {
    register(COMP_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.renamed = n.old; delete n.old; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set({
      $path: '/a', $type: 'dir',
      '#stats': { $type: COMP_TYPE, old: 42 },
      snapshot: { $type: COMP_TYPE, old: 7 },
    });

    const got = await tree.get('/a');
    const stats = got?.['#stats'] as Record<string, unknown>;
    assert.equal(stats.renamed, 42);
    assert.equal(stats.$v, 1);

    const snapshot = got?.snapshot as Record<string, unknown>;
    assert.equal(snapshot.old, 7);
    assert.equal(snapshot.$v, undefined, 'bare $type value is plain data — never migrated');
  });

  it('writes the migrated node back to the inner tree', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.fixed = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, {}));

    await tree.get('/a');
    const raw = await inner.get('/a');
    assert.equal(raw?.fixed, true);
    assert.equal(raw?.$v, 1);
  });

  it('set() stamps $v on node and # components', async () => {
    register(TEST_TYPE, 'migrate', () => ({ 1: () => {} }));
    register(COMP_TYPE, 'migrate', () => ({ 1: () => {}, 2: () => {} }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await tree.set({
      $path: '/a', $type: TEST_TYPE,
      '#stats': { $type: COMP_TYPE },
    });

    const raw = await inner.get('/a');
    assert.equal(raw?.$v, 1);
    assert.equal((raw?.['#stats'] as Record<string, unknown>).$v, 2);
  });

  it('getChildren and scanChildren serve migrated nodes', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.migrated = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/', 'root', {}));
    await inner.set(createNode('/a', TEST_TYPE, {}));
    await inner.set(createNode('/b', TEST_TYPE, {}));

    const { items } = await tree.getChildren('/');
    for (const n of items.filter(n => n.$type === TEST_TYPE)) {
      assert.equal(n.migrated, true);
      assert.equal(n.$v, 1);
    }

    assert.ok(tree.scanChildren, 'memory tree exposes scanChildren — wrapper must too');
    for await (const entry of tree.scanChildren('/')) {
      if (entry.node.$type !== TEST_TYPE) continue;
      assert.equal(entry.node.migrated, true);
      assert.equal(entry.node.$v, 1);
    }
  });

  it('does not touch types with no registered migrations when others have them', async () => {
    register(UNREL_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.bumped = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/plain', 'dir', { label: 'x' }));

    const got = await tree.get('/plain');
    assert.equal(got?.bumped, undefined);
    assert.equal(got?.$v, undefined);
  });
});
