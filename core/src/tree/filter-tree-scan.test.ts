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
