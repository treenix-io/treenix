import { createNode } from '#core';
import { KernelError } from '#errors';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resolveReadPlan } from './resolve-plan';

describe('resolveReadPlan', () => {
  let tree: ReturnType<typeof createMemoryTree>;

  beforeEach(() => {
    tree = createMemoryTree();
  });

  it('non-mount path: plan source = path, no viewWhere', async () => {
    await tree.set(createNode('/orders', 'folder'));
    const { plan } = await resolveReadPlan(tree, '/orders');
    assert.deepEqual(plan, { source: '/orders' });
  });

  it('caller query attached as callerWhere', async () => {
    await tree.set(createNode('/orders', 'folder'));
    const { plan } = await resolveReadPlan(tree, '/orders', { status: 'new' });
    assert.deepEqual(plan, { source: '/orders', callerWhere: { status: 'new' } });
  });

  it('query mount: source/match → plan.source/viewWhere', async () => {
    await tree.set({
      $path: '/orders/incoming',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: { 'status.value': 'incoming' } },
    });
    const { plan } = await resolveReadPlan(tree, '/orders/incoming', { kind: 'urgent' });
    assert.equal(plan.source, '/orders');
    assert.deepEqual(plan.viewWhere, { 'status.value': 'incoming' });
    assert.deepEqual(plan.callerWhere, { kind: 'urgent' });
  });

  it('query mount with no caller query: no callerWhere field on plan', async () => {
    await tree.set({
      $path: '/orders/incoming',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: {} },
    });
    const { plan } = await resolveReadPlan(tree, '/orders/incoming');
    assert.equal('callerWhere' in plan, false);
  });

  it('query mount with empty match: viewWhere = {}', async () => {
    await tree.set({
      $path: '/all-orders',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: {} },
    });
    const { plan } = await resolveReadPlan(tree, '/all-orders');
    assert.deepEqual(plan.viewWhere, {});
  });

  it('query mount missing source: throws', async () => {
    await tree.set({
      $path: '/bad',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '', match: {} },
    });
    await assert.rejects(
      () => resolveReadPlan(tree, '/bad'),
      (e) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('query mount missing match: throws (same rule as the adapter)', async () => {
    await tree.set({
      $path: '/bad',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders' },
    });
    await assert.rejects(
      () => resolveReadPlan(tree, '/bad'),
      (e) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('disabled query mount plans the node own children (same rule as withMounts)', async () => {
    await tree.set({
      $path: '/orders/incoming',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: {}, disabled: true },
    });
    const { plan } = await resolveReadPlan(tree, '/orders/incoming');
    assert.deepEqual(plan, { source: '/orders/incoming' });
  });

  it('non-query mount type ignored (e.g. t.mount.fs)', async () => {
    await tree.set({
      $path: '/fsmount',
      $type: 'folder',
      '#mount': { $type: 't.mount.fs', root: '/tmp' },
    });
    const { plan } = await resolveReadPlan(tree, '/fsmount');
    assert.deepEqual(plan, { source: '/fsmount' });
  });

  it('mountDeps always includes the requested path', async () => {
    await tree.set(createNode('/x', 'folder'));
    const { mountDeps } = await resolveReadPlan(tree, '/x');
    assert.ok(mountDeps.has('/x'));
  });
});
