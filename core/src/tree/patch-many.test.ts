import { A, R, W } from '#kernel/types';
// patchMany contract (core-gk8.15) — atomic multi-node patch under one
// ancestor. Contract suite runs against every concrete adapter (memory, fs);
// combinator/policy/pipeline semantics follow in their own describes.

import { createNode, register, unregister } from '#core';
import { KernelError } from '#errors';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { createFilterTree, createMemoryTree, createOverlayTree, type Tree, type TreeSource } from './index';
import { createRepathTree } from './repath';

const code = (expected: string) => (e: unknown) =>
  e instanceof KernelError && e.code === expected;

// ── adapter contract: memory + fs ──

interface Factory {
  name: string;
  setup: () => Promise<TreeSource>;
  teardown: () => Promise<void>;
}

function suite(factory: Factory) {
  describe(`patchMany contract: ${factory.name}`, () => {
    let tree: TreeSource;

    afterEach(async () => {
      await factory.teardown();
    });

    async function seed() {
      tree = await factory.setup();
      await tree.set(createNode('/p', 'dir'));
      await tree.set(createNode('/p/a', 'item', { n: 1 }));
      await tree.set(createNode('/p/b', 'item', { n: 2 }));
      await tree.set(createNode('/p/c', 'item', { n: 3 }));
      return tree;
    }

    it('happy path: N=3 applies all members with a $rev bump each', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
        { path: '/p/c', ops: [['r', 'n', 30]] },
      ]);

      for (const [p, n] of [['/p/a', 10], ['/p/b', 20], ['/p/c', 30]] as const) {
        const node = await tree.get(p);
        assert.equal(node?.n, n);
        assert.equal(node?.$rev, 2, `${p} bumped once`);
      }
    });

    it('the ancestor itself may be a member', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p', ops: [['a', 'label', 'x']] },
        { path: '/p/a', ops: [['r', 'n', 11]] },
      ]);
      assert.equal((await tree.get('/p'))?.label, 'x');
      assert.equal((await tree.get('/p/a'))?.n, 11);
    });

    it('empty batch is rejected', async () => {
      tree = await seed();
      await assert.rejects(tree.patchMany!('/p', []), code('INVALID'));
    });

    it('entry outside the ancestor is rejected, nothing written', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/px/evil', ops: [['r', 'n', 1]] },
        ]),
        code('INVALID'),
      );
      assert.equal((await tree.get('/p/a'))?.n, 1);
    });

    it('duplicate entry paths are rejected, nothing written', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/a', ops: [['r', 'n', 99]] },
        ]),
        code('INVALID'),
      );
      assert.equal((await tree.get('/p/a'))?.n, 1);
    });

    it('mid-batch failing test op denies the WHOLE batch — earlier member untouched', async () => {
      tree = await seed();
      const before = await tree.get('/p/a');

      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/b', ops: [['t', '$rev', 999], ['r', 'n', 20]] },
        ]),
        code('CONFLICT'),
      );

      assert.deepEqual(await tree.get('/p/a'), before, 'member #1 byte-identical, $rev unchanged');
      assert.equal((await tree.get('/p/b'))?.n, 2);
    });

    it('missing member denies the whole batch with NOT_FOUND, nothing written', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/ghost', ops: [['r', 'n', 1]] },
        ]),
        code('NOT_FOUND'),
      );
      assert.equal((await tree.get('/p/a'))?.n, 1);
    });

    it('test-only member: evaluated but not written, no $rev bump; mutating members commit', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/a', ops: [['t', 'n', 1]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]);

      const a = await tree.get('/p/a');
      assert.equal(a?.n, 1);
      assert.equal(a?.$rev, 1, 'test-only member keeps its $rev');
      const b = await tree.get('/p/b');
      assert.equal(b?.n, 20);
      assert.equal(b?.$rev, 2);
    });

    // ── set-members (core-gk8.10 stage 2) ──

    it('set-member creates at a new path', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/new', node: createNode('/p/new', 'item', { n: 42 }) },
      ]);
      const created = await tree.get('/p/new');
      assert.equal(created?.n, 42);
      assert.equal(created?.$rev, 1);
    });

    it('set-member OCC mismatch denies the whole batch, nothing written', async () => {
      tree = await seed();
      const stale = createNode('/p/b', 'item', { n: 99 });
      stale.$rev = 999;

      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/new', node: createNode('/p/new', 'item', { n: 5 }) },
          { path: '/p/b', node: stale },
        ]),
        code('CONFLICT'),
      );

      assert.equal((await tree.get('/p/a'))?.n, 1);
      assert.equal(await tree.get('/p/new'), undefined, 'earlier create member unwritten');
      const b = await tree.get('/p/b');
      assert.equal(b?.n, 2);
      assert.equal(b?.$rev, 1);
    });

    it('mixed batch (ops + OCC replace + create) applies atomically', async () => {
      tree = await seed();
      const replacement = createNode('/p/b', 'item', { n: 200 });
      replacement.$rev = 1; // matches stored — OCC set

      await tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', node: replacement },
        { path: '/p/new', node: createNode('/p/new', 'item', { n: 5 }) },
      ]);

      const a = await tree.get('/p/a');
      assert.equal(a?.n, 10);
      assert.equal(a?.$rev, 2);
      const b = await tree.get('/p/b');
      assert.equal(b?.n, 200);
      assert.equal(b?.$rev, 2, 'OCC set bumps the stored $rev');
      assert.equal((await tree.get('/p/new'))?.$rev, 1);
    });

    it('set-member blind upsert replaces an existing node', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/a', node: createNode('/p/a', 'item', { label: 'fresh' }) },
      ]);

      const a = await tree.get('/p/a');
      assert.equal(a?.label, 'fresh');
      assert.equal(a?.n, undefined, 'full-node write, not a merge');
      // Mirrors Tree.set blind upsert: $rev advances from the STORED node
      // (ns6p.4 invariant 24, owner-approved 2026-07-18 — was reset-to-1).
      assert.equal(a?.$rev, 2);
    });

    it('failing later member leaves an earlier set-member unwritten (all-or-nothing)', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/new', node: createNode('/p/new', 'item', { n: 5 }) },
          { path: '/p/ghost', ops: [['r', 'n', 1]] },
        ]),
        code('NOT_FOUND'),
      );
      assert.equal(await tree.get('/p/new'), undefined);
    });

    it('set-member node.$path mismatching its entry path is rejected', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/x', node: createNode('/p/y', 'item', { n: 1 }) },
        ]),
        code('INVALID'),
      );
      assert.equal(await tree.get('/p/x'), undefined);
      assert.equal(await tree.get('/p/y'), undefined);
    });
  });
}

suite({
  name: 'memory',
  setup: async () => createMemoryTree(),
  teardown: async () => {},
});

{
  let dir: string | undefined;
  suite({
    name: 'fs',
    setup: async () => {
      dir = await mkdtemp(join(tmpdir(), 'treenix-patchmany-fs-'));
      return await createFsTree(dir);
    },
    teardown: async () => {
      if (dir) {
        await rm(dir, { recursive: true, force: true });
        dir = undefined;
      }
    },
  });
}

// ── layer combinators: filter / overlay ──

describe('patchMany: filter/overlay layers', () => {
  it('mixed-layer batch is rejected, nothing written', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);
    await upper.set(createNode('/p/a', 'item', { n: 1, up: true }));
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    await assert.rejects(
      tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]),
      code('INVALID'),
    );
    assert.equal((await upper.get('/p/a'))?.n, 1);
    assert.equal((await lower.get('/p/b'))?.n, 2);
  });

  it('single-layer batch forwards and commits', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);
    await lower.set(createNode('/p/a', 'item', { n: 1 }));
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    await tree.patchMany!('/p', [
      { path: '/p/a', ops: [['r', 'n', 10]] },
      { path: '/p/b', ops: [['r', 'n', 20]] },
    ]);
    assert.equal((await lower.get('/p/a'))?.n, 10);
    assert.equal((await lower.get('/p/b'))?.n, 20);
  });

  it('layer without patchMany fails loud — no silent per-member fallback', async () => {
    const m = createMemoryTree();
    // Hand-built facade WITHOUT patchMany — models a capability-less layer.
    const bare: Tree = {
      get: m.get.bind(m),
      getChildren: m.getChildren.bind(m),
      set: m.set.bind(m),
      remove: m.remove.bind(m),
      patch: m.patch.bind(m),
    };
    const tree = createFilterTree(createMemoryTree(), bare, () => false);
    await bare.set(createNode('/p/a', 'item', { n: 1 }));

    await assert.rejects(
      tree.patchMany!('/p', [{ path: '/p/a', ops: [['r', 'n', 10]] }]),
      code('INVALID'),
    );
    assert.equal((await bare.get('/p/a'))?.n, 1);
  });

  it('overlay routes the batch to upper; a lower-only member denies the batch', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createOverlayTree(upper, lower);
    await upper.set(createNode('/p/a', 'item', { n: 1 }));
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    // Both visible through the overlay, but /p/b lives only in lower — the
    // write layer (upper) can't own it, so the whole batch is denied.
    await assert.rejects(
      tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]),
      code('NOT_FOUND'),
    );
    assert.equal((await upper.get('/p/a'))?.n, 1);

    await tree.patchMany!('/p', [{ path: '/p/a', ops: [['r', 'n', 10]] }]);
    assert.equal((await upper.get('/p/a'))?.n, 10);
  });

  it('set-member routes by the INCOMING node: creates in upper and in lower', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);

    await tree.patchMany!('/p', [
      { path: '/p/u', node: createNode('/p/u', 'item', { up: true }) },
    ]);
    assert.equal((await upper.get('/p/u'))?.up, true);
    assert.equal(await lower.get('/p/u'), undefined);

    await tree.patchMany!('/p', [
      { path: '/p/l', node: createNode('/p/l', 'item', { n: 1 }) },
    ]);
    assert.equal((await lower.get('/p/l'))?.n, 1);
    assert.equal(await upper.get('/p/l'), undefined);
  });

  it('set-member routed upper + ops-member routed lower denies the batch, nothing written', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    await assert.rejects(
      tree.patchMany!('/p', [
        { path: '/p/new', node: createNode('/p/new', 'item', { up: true }) },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]),
      code('INVALID'),
    );
    assert.equal(await upper.get('/p/new'), undefined);
    assert.equal((await lower.get('/p/b'))?.n, 2);
  });
});

// ── repath ──

describe('patchMany: repath', () => {
  it('translates ancestor and every member path to the remote namespace', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data/p', 'dir'));
    await inner.set(createNode('/data/p/a', 'item', { n: 1 }));
    await inner.set(createNode('/data/p/b', 'item', { n: 2 }));
    const tree = createRepathTree(inner, '/app', '/data');

    await tree.patchMany!('/app/p', [
      { path: '/app/p/a', ops: [['r', 'n', 10]] },
      { path: '/app/p/b', ops: [['r', 'n', 20]] },
    ]);
    assert.equal((await inner.get('/data/p/a'))?.n, 10);
    assert.equal((await inner.get('/data/p/b'))?.n, 20);
  });

  it('set-member: entry path AND node.$path both translate to the remote namespace', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data/p', 'dir'));
    const tree = createRepathTree(inner, '/app', '/data');

    await tree.patchMany!('/app/p', [
      { path: '/app/p/new', node: createNode('/app/p/new', 'item', { n: 7 }) },
    ]);

    const created = await inner.get('/data/p/new');
    assert.equal(created?.n, 7);
    assert.equal(created?.$path, '/data/p/new');
  });
});
