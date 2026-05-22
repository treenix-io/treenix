import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTree } from '#tree';
import { withRefIndex } from './refs';

describe('withRefIndex', () => {
  it('extracts $ref fields into $refs', async () => {
    const tree = withRefIndex(createMemoryTree());
    await tree.set({
      $path: '/order/1',
      $type: 'cafe.order',
      customer: { $type: 'ref', $ref: '/customers/ivan' },
      items: [{ $type: 'ref', $ref: '/menu/latte' }],
    });

    const node = await tree.get('/order/1');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 2);
    assert.ok(node.$refs.some(r => r.t === '/customers/ivan' && r.f === '#customer'));
    assert.ok(node.$refs.some(r => r.t === '/menu/latte' && r.f === '#items.0'));
  });

  it('preserves standalone refs (no f:)', async () => {
    const tree = withRefIndex(createMemoryTree());
    await tree.set({
      $path: '/factory',
      $type: 'mfg.factory',
      $refs: [{ t: '/suppliers/bob', d: { $type: 'supplies', since: '2025-01' } }],
    });

    const node = await tree.get('/factory');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 1);
    assert.equal(node.$refs[0].t, '/suppliers/bob');
    assert.equal(node.$refs[0].d?.$type, 'supplies');
    assert.equal(node.$refs[0].f, undefined);
  });

  it('merges standalone + derived refs', async () => {
    const tree = withRefIndex(createMemoryTree());
    await tree.set({
      $path: '/order/2',
      $type: 'cafe.order',
      customer: { $type: 'ref', $ref: '/customers/ivan' },
      $refs: [{ t: '/promos/summer', d: { $type: 'applied-promo' } }],
    });

    const node = await tree.get('/order/2');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 2);
    // standalone first, then derived
    assert.equal(node.$refs[0].t, '/promos/summer');
    assert.equal(node.$refs[1].t, '/customers/ivan');
  });

  it('returns undefined $refs when no refs exist', async () => {
    const tree = withRefIndex(createMemoryTree());
    await tree.set({ $path: '/plain', $type: 'dir' });

    const node = await tree.get('/plain');
    assert.equal(node?.$refs, undefined);
    assert.equal(Object.hasOwn(node!, '$refs'), false);
  });

  it('scans nested component refs', async () => {
    const tree = withRefIndex(createMemoryTree());
    await tree.set({
      $path: '/node',
      $type: 'test',
      delivery: {
        $type: 'logistics.delivery',
        courier: { $type: 'ref', $ref: '/couriers/alex' },
        warehouse: { $type: 'ref', $ref: '/warehouses/main' },
      },
    });

    const node = await tree.get('/node');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 2);
    assert.ok(node.$refs.some(r => r.t === '/couriers/alex' && r.f === '#delivery.courier'));
    assert.ok(node.$refs.some(r => r.t === '/warehouses/main' && r.f === '#delivery.warehouse'));
  });

  it('updates $refs after patch (single write)', async () => {
    const tree = withRefIndex(createMemoryTree());
    await tree.set({
      $path: '/order/3', $type: 'cafe.order',
      customer: { $type: 'ref', $ref: '/customers/alice' },
    });

    await tree.patch('/order/3', [
      ['r', 'customer', { $type: 'ref', $ref: '/customers/bob' }],
    ]);

    const node = await tree.get('/order/3');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 1);
    assert.equal(node.$refs[0].t, '/customers/bob');
    assert.equal(node.$refs[0].f, '#customer');
  });

  it('removes $refs when patch clears all refs', async () => {
    const tree = withRefIndex(createMemoryTree());
    await tree.set({
      $path: '/order/4', $type: 'cafe.order',
      customer: { $type: 'ref', $ref: '/customers/alice' },
    });

    await tree.patch('/order/4', [['d', 'customer']]);

    const node = await tree.get('/order/4');
    assert.equal(node?.$refs, undefined);
  });

  it('patch calls inner.patch once, never inner.set', async () => {
    const inner = createMemoryTree();
    let patchCalls = 0;
    let setCalls = 0;
    const spy: typeof inner = {
      ...inner,
      async patch(...args: Parameters<typeof inner.patch>) { patchCalls++; return inner.patch(...args); },
      async set(...args: Parameters<typeof inner.set>) { setCalls++; return inner.set(...args); },
    };
    const tree = withRefIndex(spy);

    await tree.set({ $path: '/x', $type: 't', link: { $type: 'ref', $ref: '/y' } });
    setCalls = 0; // reset after setup

    await tree.patch('/x', [['r', 'link', { $type: 'ref', $ref: '/z' }]]);
    assert.equal(patchCalls, 1, 'should call inner.patch exactly once');
    assert.equal(setCalls, 0, 'should never call inner.set during patch');
  });

  it('test-only patch validates without delegating to inner.patch', async () => {
    const inner = createMemoryTree();
    let patchCalls = 0;
    const spy: typeof inner = {
      ...inner,
      async patch(...args: Parameters<typeof inner.patch>) { patchCalls++; return inner.patch(...args); },
    };
    const tree = withRefIndex(spy);
    await tree.set({ $path: '/x', $type: 't', value: 1 });
    const before = await tree.get('/x');

    await tree.patch('/x', [['t', 'value', 1]]);

    const after = await tree.get('/x');
    assert.equal(patchCalls, 0);
    assert.equal(after?.$rev, before?.$rev);
  });
});
