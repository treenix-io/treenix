import { createNode, type NodeData } from '#core';
import { OpError } from '#errors';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryTree } from './index';
import { executeList, type Projector, type ReadPlan } from './read-runtime';

// Identity projector — returns node verbatim.
const identityProject: Projector = async (node) => node;

async function seed(paths: string[]): Promise<ReturnType<typeof createMemoryTree>> {
  const t = createMemoryTree();
  for (const p of paths) await t.set(createNode(p, 'item'));
  return t;
}

describe('executeList', () => {
  it('returns all items when below limit, no nextCursor', async () => {
    const source = await seed(['/x/a', '/x/b', '/x/c']);
    const plan: ReadPlan = { source: '/x' };
    const res = await executeList(source, plan, { limit: 10 }, identityProject);
    assert.equal(res.items.length, 3);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a', '/x/b', '/x/c']);
    assert.equal(res.nextCursor, undefined);
  });

  it('paginates: returns limit + nextCursor when more items exist', async () => {
    const source = await seed(['/x/a', '/x/b', '/x/c', '/x/d']);
    const plan: ReadPlan = { source: '/x' };
    const page1 = await executeList(source, plan, { limit: 2 }, identityProject);
    assert.equal(page1.items.length, 2);
    assert.deepEqual(page1.items.map(n => n.$path), ['/x/a', '/x/b']);
    assert.equal(page1.nextCursor, '/x/b');

    const page2 = await executeList(source, plan, { limit: 2, cursor: page1.nextCursor }, identityProject);
    assert.equal(page2.items.length, 2);
    assert.deepEqual(page2.items.map(n => n.$path), ['/x/c', '/x/d']);
    assert.equal(page2.nextCursor, undefined);
  });

  it('empty source returns empty items', async () => {
    const source = await seed([]);
    const plan: ReadPlan = { source: '/x' };
    const res = await executeList(source, plan, { limit: 10 }, identityProject);
    assert.deepEqual(res.items, []);
    assert.equal(res.nextCursor, undefined);
  });

  it('viewWhere filters raw nodes BEFORE projection', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', flag: 1 } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', flag: 2 } as NodeData);
    await source.set({ $path: '/x/c', $type: 'item', flag: 1 } as NodeData);

    const plan: ReadPlan = { source: '/x', viewWhere: { flag: 1 } };
    const res = await executeList(source, plan, { limit: 10 }, identityProject);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a', '/x/c']);
  });

  it('callerWhere filters visible nodes AFTER projection', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', kind: 'A' } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', kind: 'B' } as NodeData);

    const plan: ReadPlan = { source: '/x', callerWhere: { kind: 'A' } };
    const res = await executeList(source, plan, { limit: 10 }, identityProject);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a']);
  });

  it('viewWhere matches $type (system field mapped via _type)', async () => {
    const source = createMemoryTree();
    await source.set(createNode('/x/a', 'fruit.apple'));
    await source.set(createNode('/x/b', 'fruit.banana'));
    await source.set(createNode('/x/c', 'fruit.apple'));

    const plan: ReadPlan = { source: '/x', viewWhere: { $type: 'fruit.apple' } };
    const res = await executeList(source, plan, { limit: 10 }, identityProject);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a', '/x/c']);
  });

  it('projection returning null hides node', async () => {
    const source = await seed(['/x/a', '/x/b', '/x/c']);
    const hideB: Projector = async (n) => n.$path === '/x/b' ? null : n;
    const plan: ReadPlan = { source: '/x' };
    const res = await executeList(source, plan, { limit: 10 }, hideB);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a', '/x/c']);
  });

  it('limit must be a positive integer', async () => {
    const source = await seed(['/x/a']);
    const plan: ReadPlan = { source: '/x' };
    await assert.rejects(
      () => executeList(source, plan, { limit: 0 }, identityProject),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
    await assert.rejects(
      () => executeList(source, plan, { limit: -1 }, identityProject),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
    await assert.rejects(
      () => executeList(source, plan, { limit: 1.5 }, identityProject),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('budget exhaustion throws RESOURCE_EXHAUSTED', async () => {
    const source = await seed(['/x/a', '/x/b', '/x/c', '/x/d', '/x/e']);
    const plan: ReadPlan = { source: '/x' };
    await assert.rejects(
      () => executeList(source, plan, { limit: 10, budget: { maxRawScanned: 2 } }, identityProject),
      (e: unknown) => e instanceof OpError && e.code === 'RESOURCE_EXHAUSTED',
    );
  });

  it('rejects unsafe callerWhere ($where)', async () => {
    const source = await seed(['/x/a']);
    const plan: ReadPlan = { source: '/x', callerWhere: { $where: 'true' } };
    await assert.rejects(
      () => executeList(source, plan, { limit: 10 }, identityProject),
      /Forbidden sift operator/,
    );
  });

  it('aborts scanning when signal triggers', async () => {
    const source = await seed(['/x/a', '/x/b', '/x/c']);
    const plan: ReadPlan = { source: '/x' };
    const ac = new AbortController();
    ac.abort(new Error('test abort'));
    await assert.rejects(
      () => executeList(source, plan, { limit: 10, signal: ac.signal }, identityProject),
      /test abort/,
    );
  });

  it('cursor + viewWhere: filtering happens after cursor advance', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', flag: 1 } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', flag: 2 } as NodeData);
    await source.set({ $path: '/x/c', $type: 'item', flag: 1 } as NodeData);
    await source.set({ $path: '/x/d', $type: 'item', flag: 1 } as NodeData);

    const plan: ReadPlan = { source: '/x', viewWhere: { flag: 1 } };
    const page1 = await executeList(source, plan, { limit: 1 }, identityProject);
    assert.deepEqual(page1.items.map(n => n.$path), ['/x/a']);
    assert.equal(page1.nextCursor, '/x/a');

    const page2 = await executeList(source, plan, { limit: 10, cursor: page1.nextCursor }, identityProject);
    assert.deepEqual(page2.items.map(n => n.$path), ['/x/c', '/x/d']);
    assert.equal(page2.nextCursor, undefined);
  });
});
