// Contract for createFilterTree.scanChildren — verifies the streaming
// k-way merge by $path with "upper wins on collision". Stand-alone from
// scan-children.contract.test.ts because the contract suite seeds via
// tree.set() (predicate-routed); merge tests need to seed upper and
// lower independently.

import { createNode, type NodeData } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFilterTree, createMemoryTree, type ChildEntry } from './index';

async function collect(iter: AsyncIterable<ChildEntry>): Promise<ChildEntry[]> {
  const out: ChildEntry[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

async function seed(tree: ReturnType<typeof createMemoryTree>, paths: string[]) {
  for (const p of paths) await tree.set(createNode(p, 'item'));
}

/** Wrap a tree so its scanChildren records how many times its generator's
 *  finally ran — i.e. how many times the cursor was actually closed. */
function instrumented(tree: ReturnType<typeof createMemoryTree>) {
  const state = { closed: 0 };
  const wrapped: typeof tree = {
    ...tree,
    async *scanChildren(parent, opts, ctx) {
      try {
        yield* tree.scanChildren!(parent, opts, ctx);
      } finally {
        state.closed++;
      }
    },
  };
  return { tree: wrapped, state };
}

describe('createFilterTree.scanChildren — k-way merge', () => {
  it('disjoint paths: yields union in sorted order', async () => {
    const u = createMemoryTree();
    const l = createMemoryTree();
    await seed(u, ['/x/b', '/x/d']);
    await seed(l, ['/x/a', '/x/c']);
    const merged = createFilterTree(u, l, () => true);
    const entries = await collect(merged.scanChildren!('/x'));
    assert.deepEqual(entries.map(e => e.node.$path), ['/x/a', '/x/b', '/x/c', '/x/d']);
  });

  it('upper wins on $path collision', async () => {
    const u = createMemoryTree();
    const l = createMemoryTree();
    await u.set({ $path: '/x/a', $type: 'item', src: 'upper' } as NodeData);
    await l.set({ $path: '/x/a', $type: 'item', src: 'lower' } as NodeData);
    const merged = createFilterTree(u, l, () => true);
    const entries = await collect(merged.scanChildren!('/x'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].node['src'], 'upper');
  });

  it('upper empty: yields lower untouched', async () => {
    const u = createMemoryTree();
    const l = createMemoryTree();
    await seed(l, ['/x/a', '/x/b']);
    const merged = createFilterTree(u, l, () => true);
    const entries = await collect(merged.scanChildren!('/x'));
    assert.deepEqual(entries.map(e => e.node.$path), ['/x/a', '/x/b']);
  });

  it('lower empty: yields upper untouched', async () => {
    const u = createMemoryTree();
    const l = createMemoryTree();
    await seed(u, ['/x/a', '/x/b']);
    const merged = createFilterTree(u, l, () => true);
    const entries = await collect(merged.scanChildren!('/x'));
    assert.deepEqual(entries.map(e => e.node.$path), ['/x/a', '/x/b']);
  });

  it('after cursor honored — exclusive on the merged stream', async () => {
    const u = createMemoryTree();
    const l = createMemoryTree();
    await seed(u, ['/x/b', '/x/d']);
    await seed(l, ['/x/a', '/x/c']);
    const merged = createFilterTree(u, l, () => true);

    const all = await collect(merged.scanChildren!('/x'));
    assert.equal(all.length, 4);

    // Resume strictly after the 2nd entry (/x/b).
    const rest = await collect(merged.scanChildren!('/x', { after: all[1].cursor }));
    assert.deepEqual(rest.map(e => e.node.$path), ['/x/c', '/x/d']);
  });

  it('early break leaves both iterators clean for next scan', async () => {
    const u = createMemoryTree();
    const l = createMemoryTree();
    await seed(u, ['/x/b', '/x/d']);
    await seed(l, ['/x/a', '/x/c']);
    const merged = createFilterTree(u, l, () => true);

    let n = 0;
    for await (const _ of merged.scanChildren!('/x')) {
      n++;
      if (n === 2) break;
    }
    const fresh = await collect(merged.scanChildren!('/x'));
    assert.equal(fresh.length, 4);
  });

  it('early break closes BOTH inner cursors (core-0x6)', async () => {
    const u = instrumented(createMemoryTree());
    const l = instrumented(createMemoryTree());
    await seed(u.tree, ['/x/b', '/x/d']);
    await seed(l.tree, ['/x/a', '/x/c']);
    const merged = createFilterTree(u.tree, l.tree, () => true);

    let n = 0;
    for await (const _ of merged.scanChildren!('/x')) {
      if (++n === 1) break;
    }
    assert.equal(u.state.closed, 1, 'upper cursor closed on early break');
    assert.equal(l.state.closed, 1, 'lower cursor closed on early break');
  });

  it('abort mid-merge closes BOTH inner cursors (core-0x6)', async () => {
    const u = instrumented(createMemoryTree());
    const l = instrumented(createMemoryTree());
    await seed(u.tree, ['/x/b', '/x/d']);
    await seed(l.tree, ['/x/a', '/x/c']);
    const merged = createFilterTree(u.tree, l.tree, () => true);

    const ac = new AbortController();
    await assert.rejects(async () => {
      let n = 0;
      // Both cursors are open after the first yield; aborting then forces the
      // next loop iteration to throw with both still active.
      for await (const _ of merged.scanChildren!('/x', { signal: ac.signal })) {
        if (++n === 1) ac.abort();
      }
    });
    assert.equal(u.state.closed, 1, 'upper cursor closed on abort');
    assert.equal(l.state.closed, 1, 'lower cursor closed on abort');
  });

  it('aborts via signal between yields', async () => {
    const u = createMemoryTree();
    const l = createMemoryTree();
    await seed(u, ['/x/b']);
    await seed(l, ['/x/a']);
    const merged = createFilterTree(u, l, () => true);

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => collect(merged.scanChildren!('/x', { signal: ac.signal })),
    );
  });
});

describe('createFilterTree.patch — cross-layer relocation (core-yje)', () => {
  it('relocation strips stale $rev so the destination write does not throw OCC', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    // Predicate routes tier==='hot' → upper, else → lower.
    const tree = createFilterTree(upper, lower, (n) => n['tier'] === 'hot');

    await tree.set({ $path: '/x/a', $type: 'item', tier: 'hot', v: 1 } as NodeData);
    assert.ok(await upper.get('/x/a'), 'seeded in upper');

    // Predicate flip via patch: hot→cold relocates upper → lower. Without the
    // $rev strip, lower.set throws OCC on a node it never issued a rev for.
    await tree.patch('/x/a', [['r', 'tier', 'cold']]);
    assert.equal(await upper.get('/x/a'), undefined, 'removed from source layer');
    assert.ok(await lower.get('/x/a'), 'relocated to destination layer');

    // The relocated node is writable — a subsequent write does not throw OCC.
    await tree.patch('/x/a', [['r', 'v', 2]]);
    assert.equal((await lower.get('/x/a'))?.['v'], 2);
  });

  it('failed destination write during relocation does not lose the source node', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    // Destination (lower) rejects the relocation write.
    const failingLower: typeof lower = {
      ...lower,
      async set() { throw new Error('destination write failed'); },
    };
    const tree = createFilterTree(upper, failingLower, (n) => n['tier'] === 'hot');

    await tree.set({ $path: '/x/a', $type: 'item', tier: 'hot', v: 1 } as NodeData);
    await assert.rejects(() => tree.patch('/x/a', [['r', 'tier', 'cold']]));
    // Set-destination-first ordering: the source node survives the failure.
    assert.ok(await upper.get('/x/a'), 'source node intact after failed relocation');
  });
});
