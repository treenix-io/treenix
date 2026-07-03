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

  it('budget exhaustion returns partial page with truncated:true and no nextCursor', async () => {
    const source = await seed(['/x/a', '/x/b', '/x/c', '/x/d', '/x/e']);
    const plan: ReadPlan = { source: '/x' };
    const res = await executeList(source, plan, { limit: 10, budget: { maxRawScanned: 2 } }, identityProject);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a', '/x/b']);
    assert.equal(res.truncated, true);
    assert.equal(res.nextCursor, undefined);
  });

  it('budget exhaustion with zero matches still returns truncated:true', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', kind: 'A' } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', kind: 'A' } as NodeData);
    await source.set({ $path: '/x/c', $type: 'item', kind: 'A' } as NodeData);
    const plan: ReadPlan = { source: '/x', callerWhere: { kind: 'Z' } };
    const res = await executeList(source, plan, { limit: 10, budget: { maxRawScanned: 2 } }, identityProject);
    assert.deepEqual(res.items, []);
    assert.equal(res.truncated, true);
    assert.equal(res.nextCursor, undefined);
  });

  // Contract invariant: nextCursor and truncated are mutually exclusive.
  // nextCursor implies "more pages exist within budget"; truncated implies
  // "budget hit before completing the scan, no safe resumption". A consumer
  // that saw both would have ambiguous semantics — assert it never happens.
  it('contract invariant: never returns both nextCursor and truncated', async () => {
    const source = await seed(['/x/a', '/x/b', '/x/c', '/x/d', '/x/e']);
    const plan: ReadPlan = { source: '/x' };

    // Normal pagination: nextCursor only.
    const paginated = await executeList(source, plan, { limit: 2 }, identityProject);
    assert.ok(paginated.nextCursor, 'pagination case sets nextCursor');
    assert.equal(paginated.truncated, undefined, 'pagination case does not set truncated');

    // Budget hit: truncated only.
    const budgeted = await executeList(source, plan, { limit: 10, budget: { maxRawScanned: 2 } }, identityProject);
    assert.equal(budgeted.truncated, true, 'budget case sets truncated');
    assert.equal(budgeted.nextCursor, undefined, 'budget case does not set nextCursor');

    // Full scan within budget: neither.
    const complete = await executeList(source, plan, { limit: 10 }, identityProject);
    assert.equal(complete.nextCursor, undefined, 'complete scan has no nextCursor');
    assert.equal(complete.truncated, undefined, 'complete scan is not truncated');
  });

  it('rejects unsafe callerWhere ($where)', async () => {
    const source = await seed(['/x/a']);
    const plan: ReadPlan = { source: '/x', callerWhere: { $where: 'true' } };
    await assert.rejects(
      () => executeList(source, plan, { limit: 10 }, identityProject),
      /Forbidden sift operator/,
    );
  });

  // ── callerWhere hidden-field / malformed handling (core-fnv, MVP rule 8) ──

  // Projector that hides the `secret` field — models an actor lacking R on it.
  const stripSecret: Projector = async (node) => {
    const { secret, ...rest } = node;
    return rest as NodeData;
  };

  it('malformed callerWhere throws BAD_REQUEST (not a generic error)', async () => {
    const source = await seed(['/x/a']);
    const plan: ReadPlan = { source: '/x', callerWhere: { $where: 'true' } };
    await assert.rejects(
      () => executeList(source, plan, { limit: 10 }, identityProject),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('callerWhere on a hidden field throws FORBIDDEN (raw matches, projected does not)', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', secret: 'top' } as NodeData);
    const plan: ReadPlan = { source: '/x', callerWhere: { secret: 'top' } };
    await assert.rejects(
      () => executeList(source, plan, { limit: 10 }, stripSecret),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('callerWhere on a visible field still works when a projector strips other fields', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', kind: 'A', secret: 's' } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', kind: 'B', secret: 's' } as NodeData);
    const plan: ReadPlan = { source: '/x', callerWhere: { kind: 'A' } };
    const res = await executeList(source, plan, { limit: 10 }, stripSecret);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a'], 'matched on the visible field, no false FORBIDDEN');
  });

  it('callerWhere on a hidden field ABSENT for every row passes silently (documented limitation)', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item' } as NodeData); // no secret at all
    const plan: ReadPlan = { source: '/x', callerWhere: { secret: 'top' } };
    const res = await executeList(source, plan, { limit: 10 }, stripSecret);
    assert.deepEqual(res.items, [], 'no rawMatch → no oracle → silent empty, per MVP known limitation');
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
