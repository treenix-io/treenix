import { createNode, type NodeData } from '#core';
import { KernelError } from '#errors';
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
    assert.ok(page1.nextCursor, 'cursor is opaque — only presence is contract');

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
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
    await assert.rejects(
      () => executeList(source, plan, { limit: -1 }, identityProject),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
    await assert.rejects(
      () => executeList(source, plan, { limit: 1.5 }, identityProject),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
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

  it('malformed callerWhere throws INVALID (not a generic error)', async () => {
    const source = await seed(['/x/a']);
    const plan: ReadPlan = { source: '/x', callerWhere: { $where: 'true' } };
    await assert.rejects(
      () => executeList(source, plan, { limit: 10 }, identityProject),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('a predicate over the size limit — a long $in or a long literal — is refused with BUDGET before any node is projected', async () => {
    const source = await seed(['/x/a', '/x/b']);
    let projected = 0;
    const counting: Projector = async (node) => { projected++; return node; };

    const longIn = { tag: { $in: Array.from({ length: 20_000 }, (_, i) => i) } };
    const longLiteral = { name: 'x'.repeat(17 * 1024) };
    for (const plan of [{ source: '/x', callerWhere: longIn }, { source: '/x', viewWhere: longLiteral }]) {
      await assert.rejects(
        () => executeList(source, plan, { limit: 10 }, counting),
        (e: unknown) => e instanceof KernelError && e.code === 'BUDGET',
      );
    }
    assert.equal(projected, 0);
  });

  // A data-dependent refusal is an oracle: "FORBIDDEN iff hidden raw matches"
  // leaked hidden values bit by bit. Right and wrong guesses must look alike.
  it('callerWhere on a hidden field answers the same for right and wrong guesses', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', secret: 'top' } as NodeData);
    for (const guess of ['top', 'nope']) {
      const res = await executeList(source, { source: '/x', callerWhere: { secret: guess } }, { limit: 10 }, stripSecret);
      assert.deepEqual(res.items, [], `guess ${guess}`);
    }
  });

  it('predicates on hidden system fields are refused statically, whatever the data', async () => {
    const source = await seed(['/x/a']);
    for (const q of [{ $owner: 'alice' }, { _acl: { $exists: true } }, { $or: [{ kind: 'A' }, { $refs: 'x' }] }]) {
      await assert.rejects(
        () => executeList(source, { source: '/x', callerWhere: q }, { limit: 10 }, identityProject),
        (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
      );
      await assert.rejects(
        () => executeList(source, { source: '/x', viewWhere: q }, { limit: 10 }, identityProject),
        (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
      );
    }
  });

  it('callerWhere on a visible field still works when a projector strips other fields', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', kind: 'A', secret: 's' } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', kind: 'B', secret: 's' } as NodeData);
    const plan: ReadPlan = { source: '/x', callerWhere: { kind: 'A' } };
    const res = await executeList(source, plan, { limit: 10 }, stripSecret);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a'], 'matched on the visible field, no false FORBIDDEN');
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
    assert.ok(page1.nextCursor);

    const page2 = await executeList(source, plan, { limit: 10, cursor: page1.nextCursor }, identityProject);
    assert.deepEqual(page2.items.map(n => n.$path), ['/x/c', '/x/d']);
    assert.equal(page2.nextCursor, undefined);
  });

  // ── cursor↔plan binding (core-8an) ──

  it('rejects a cursor replayed against a different plan', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', kind: 'A' } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', kind: 'A' } as NodeData);

    const page1 = await executeList(source, { source: '/x' }, { limit: 1 }, identityProject);
    assert.ok(page1.nextCursor);

    // Same source, different predicate — different visible sequence.
    const other: ReadPlan = { source: '/x', callerWhere: { kind: 'A' } };
    await assert.rejects(
      () => executeList(source, other, { limit: 1, cursor: page1.nextCursor }, identityProject),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('accepts its own cursor under an equal plan built independently (key order differs)', async () => {
    const source = createMemoryTree();
    await source.set({ $path: '/x/a', $type: 'item', a: 1, b: 2 } as NodeData);
    await source.set({ $path: '/x/b', $type: 'item', a: 1, b: 2 } as NodeData);
    await source.set({ $path: '/x/c', $type: 'item', a: 1, b: 2 } as NodeData);

    const page1 = await executeList(source, { source: '/x', callerWhere: { a: 1, b: 2 } }, { limit: 1 }, identityProject);
    assert.ok(page1.nextCursor);

    // Fresh plan object, different key order — canonicalization must equate them.
    const page2 = await executeList(source, { source: '/x', callerWhere: { b: 2, a: 1 } }, { limit: 10, cursor: page1.nextCursor }, identityProject);
    assert.deepEqual(page2.items.map(n => n.$path), ['/x/b', '/x/c']);
  });

  it('rejects malformed cursors — raw storage cursor, garbage, empty hash', async () => {
    const source = await seed(['/x/a', '/x/b']);
    const plan: ReadPlan = { source: '/x' };
    for (const bad of ['/x/a', 'zzz', 'deadbeef.###', 'a.b.c']) {
      await assert.rejects(
        () => executeList(source, plan, { limit: 1, cursor: bad }, identityProject),
        (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
        `cursor ${JSON.stringify(bad)} must be rejected`,
      );
    }
  });

  // ── depth>1 (core-0bl) ──

  it('depth=2 yields grandchildren in path order; depth defaults to 1', async () => {
    const source = await seed(['/x/a', '/x/a/i', '/x/b']);
    const deep = await executeList(source, { source: '/x', depth: 2 }, { limit: 10 }, identityProject);
    assert.deepEqual(deep.items.map(n => n.$path), ['/x/a', '/x/a/i', '/x/b']);

    const flat = await executeList(source, { source: '/x' }, { limit: 10 }, identityProject);
    assert.deepEqual(flat.items.map(n => n.$path), ['/x/a', '/x/b']);
  });

  it('depth=-1 yields all descendants', async () => {
    const source = await seed(['/x/a', '/x/a/i', '/x/a/i/deep']);
    const res = await executeList(source, { source: '/x', depth: -1 }, { limit: 10 }, identityProject);
    assert.deepEqual(res.items.map(n => n.$path), ['/x/a', '/x/a/i', '/x/a/i/deep']);
  });

  it('deep page concatenation equals full deep scan (no dup, no skip)', async () => {
    const source = await seed(['/x/a', '/x/a/i', '/x/a/j', '/x/b', '/x/b/k']);
    const plan: ReadPlan = { source: '/x', depth: -1 };
    const full = await executeList(source, plan, { limit: 10 }, identityProject);
    assert.equal(full.items.length, 5);

    const pages: NodeData[] = [];
    let cursor: string | undefined;
    do {
      const page = await executeList(source, plan, { limit: 2, cursor }, identityProject);
      pages.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(pages.map(n => n.$path), full.items.map(n => n.$path));
  });

  it('cursor minted at one depth cannot resume a scan at another depth', async () => {
    const source = await seed(['/x/a', '/x/a/i', '/x/b']);
    const page1 = await executeList(source, { source: '/x', depth: 2 }, { limit: 1 }, identityProject);
    assert.ok(page1.nextCursor);

    await assert.rejects(
      () => executeList(source, { source: '/x' }, { limit: 1, cursor: page1.nextCursor }, identityProject),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('rejects invalid depth — zero, fractional, negatives other than -1', async () => {
    const source = await seed(['/x/a']);
    for (const depth of [0, 1.5, -2]) {
      await assert.rejects(
        () => executeList(source, { source: '/x', depth }, { limit: 1 }, identityProject),
        (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
        `depth ${depth} must be rejected`,
      );
    }
  });
});
