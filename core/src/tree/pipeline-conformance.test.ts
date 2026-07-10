// Tree-contract conformance net (cut-series 2026-07, Wave 0 — core-gk8.14 part a).
// One spec run against the memory adapter, the fs adapter, and the FULLY COMPOSED
// createPipeline. Pins CURRENT behavior so structural cuts (core-tcc1 rewiring,
// core-5fqq wrapper collapse) fail loudly instead of drifting silently.
// If a cut forces an assert change here, the cut changed behavior — stop.
//
// scanChildren adapter contract lives in scan-children.contract.test.ts; the scan
// block here runs only against the composed pipeline (not covered there).

import { createNode, type NodeData } from '#core';
import { createPipeline } from '#server/server';
import type { NodeEvent } from '#sub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { asTreeSource, createMemoryTree, type ChildEntry, type PatchOp, type Tree, type TreeWatchScope } from './index';

type Target = {
  name: string;
  setup: () => Promise<Tree>;
  teardown: () => Promise<void>;
  /** memory/fs get() returns store-isolated clones; the composed pipeline serves
   *  live cache refs BY CONTRACT (tree/cache.ts) — callers must clone. */
  readIsolation: boolean;
  /** watch/scan exist on the composed pipeline (withSubscriptions / adapters). */
  watch: boolean;
  scan: boolean;
};

const code = (expected: string) => (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === expected;

/** Race-free watch consumer: registration happens on the first next(), which this
 *  helper issues synchronously at creation — events emitted after pump() exists
 *  are never lost. take() resolves with the next event in FIFO order. */
function pump(tree: Tree, scope: TreeWatchScope) {
  const iter = tree.watch!(scope)[Symbol.asyncIterator]();
  const queue: NodeEvent[] = [];
  const waiters: ((e: NodeEvent) => void)[] = [];
  const feed = (r: IteratorResult<NodeEvent>): void => {
    if (r.done) return;
    const w = waiters.shift();
    if (w) w(r.value as NodeEvent);
    else queue.push(r.value as NodeEvent);
    void iter.next().then(feed);
  };
  void iter.next().then(feed);
  return {
    async take(): Promise<NodeEvent> {
      if (queue.length) return queue.shift()!;
      return new Promise<NodeEvent>(res => waiters.push(res));
    },
    stop: () => iter.return?.(),
  };
}

function suite(t: Target) {
  describe(`tree contract: ${t.name}`, () => {
    let tree: Tree;

    afterEach(async () => {
      await t.teardown();
    });

    async function fresh(): Promise<Tree> {
      tree = await t.setup();
      return tree;
    }

    // ── get / set ──

    it('get on a missing path returns undefined', async () => {
      await fresh();
      assert.equal(await tree.get('/nope'), undefined);
    });

    it('set→get roundtrip preserves fields and stamps a numeric $rev', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.dir', {}));
      await tree.set(createNode('/p/a', 'test.item', { name: 'A', tags: ['x', 'y'] }));

      const got = await tree.get('/p/a');
      assert.ok(got);
      assert.equal(got.$path, '/p/a');
      assert.equal(got.$type, 'test.item');
      assert.equal(got.name, 'A');
      assert.deepEqual(got.tags, ['x', 'y']);
      assert.equal(typeof got.$rev, 'number');
    });

    it('set without $rev is a blind upsert over an existing node', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.item', { name: 'A' }));
      await tree.set(createNode('/p', 'test.item', { name: 'B' }));
      const got = await tree.get('/p');
      assert.equal(got?.name, 'B');
    });

    it('mutating the caller node after set does not alter the store', async () => {
      await fresh();
      const n = createNode('/p', 'test.item', { name: 'A', tags: ['x'] });
      await tree.set(n);

      n.name = 'HACK';
      (n.tags as string[]).push('h');

      const got = await tree.get('/p');
      assert.equal(got?.name, 'A');
      assert.deepEqual(got?.tags, ['x']);
    });

    if (t.readIsolation) {
      it('mutating a node returned by get does not alter the store', async () => {
        await fresh();
        await tree.set(createNode('/p', 'test.item', { name: 'A' }));

        const got = await tree.get('/p');
        got!.name = 'HACK';

        const again = await tree.get('/p');
        assert.equal(again?.name, 'A');
      });
    }

    // ── OCC ($rev) ──

    it('set with a matching $rev succeeds and bumps by one', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.item', { name: 'A' }));
      const before = await tree.get('/p');

      await tree.set({ ...before!, name: 'B' });

      const after = await tree.get('/p');
      assert.equal(after?.name, 'B');
      assert.equal(after?.$rev, before!.$rev! + 1);
    });

    it('set with a stale $rev rejects with CONFLICT and writes nothing', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.item', { name: 'A' }));
      const r1 = await tree.get('/p');
      const r2 = await tree.get('/p');

      await tree.set({ ...r1!, name: 'first' });
      await assert.rejects(() => tree.set({ ...r2!, name: 'second' }), code('CONFLICT'));

      const got = await tree.get('/p');
      assert.equal(got?.name, 'first');
    });

    it('set with $rev on a missing node rejects with CONFLICT', async () => {
      await fresh();
      const ghost: NodeData = { ...createNode('/ghost', 'test.item', {}), $rev: 3 };
      await assert.rejects(() => tree.set(ghost), code('CONFLICT'));
    });

    // ── patch ──

    it('patch applies r/a/d atomically with a single $rev bump', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.item', { name: 'A', tags: ['x'] }));
      const before = await tree.get('/p');

      const ops: PatchOp[] = [['r', 'name', 'B'], ['a', 'extra', 'E'], ['d', 'tags']];
      await tree.patch('/p', ops);

      const got = await tree.get('/p');
      assert.equal(got?.name, 'B');
      assert.equal(got?.extra, 'E');
      assert.equal(got?.tags, undefined);
      assert.equal(got?.$rev, before!.$rev! + 1);
    });

    it('patch on a missing path rejects with NOT_FOUND', async () => {
      await fresh();
      await assert.rejects(() => tree.patch('/nope', [['r', 'x', 1]]), code('NOT_FOUND'));
    });

    it('a failing test op aborts the whole patch, node untouched', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.item', { name: 'A' }));
      const before = await tree.get('/p');

      const ops: PatchOp[] = [['t', 'name', 'WRONG'], ['r', 'name', 'B']];
      await assert.rejects(() => tree.patch('/p', ops), code('TEST_FAILED'));

      const got = await tree.get('/p');
      assert.equal(got?.name, 'A');
      assert.equal(got?.$rev, before!.$rev);
    });

    it('a passing test op lets the mutation through', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.item', { name: 'A' }));
      await tree.patch('/p', [['t', 'name', 'A'], ['r', 'name', 'B']]);
      assert.equal((await tree.get('/p'))?.name, 'B');
    });

    it('a test-only patch neither writes nor bumps $rev', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.item', { name: 'A' }));
      const before = await tree.get('/p');

      await tree.patch('/p', [['t', 'name', 'A']]);

      const got = await tree.get('/p');
      assert.equal(got?.$rev, before!.$rev);
    });

    // ── getChildren ──

    async function seedFamily() {
      await fresh();
      await tree.set(createNode('/p', 'test.dir', {}));
      await tree.set(createNode('/p/a', 'test.item', { kind: 'x' }));
      await tree.set(createNode('/p/b', 'test.item', { kind: 'y' }));
      await tree.set(createNode('/p/c', 'test.item', { kind: 'x' }));
      await tree.set(createNode('/p/a/deep', 'test.item', { kind: 'x' }));
    }

    it('lists direct children at default depth with total', async () => {
      await seedFamily();
      const page = await tree.getChildren('/p');
      assert.equal(page.total, 3);
      assert.equal(page.nextCursor, undefined);
      assert.deepEqual(page.items.map(n => n.$path).sort(), ['/p/a', '/p/b', '/p/c']);
    });

    it('depth=2 includes grandchildren', async () => {
      await seedFamily();
      const page = await tree.getChildren('/p', { depth: 2 });
      assert.deepEqual(page.items.map(n => n.$path).sort(), ['/p/a', '/p/a/deep', '/p/b', '/p/c']);
    });

    it('a missing parent yields an empty page, not an error', async () => {
      await fresh();
      const page = await tree.getChildren('/nope');
      assert.deepEqual(page.items, []);
      assert.equal(page.total, 0);
    });

    it('query filters children by data fields', async () => {
      await seedFamily();
      const page = await tree.getChildren('/p', { query: { kind: 'x' } });
      assert.deepEqual(page.items.map(n => n.$path).sort(), ['/p/a', '/p/c']);
    });

    it('limit bounds the loaded window and returns a continuation cursor', async () => {
      await seedFamily();
      const page = await tree.getChildren('/p', { limit: 2 });
      assert.equal(page.items.length, 2);
      assert.equal(page.total, 2);
      assert.ok(page.nextCursor);
    });

    // ── remove ──

    it('remove returns true and the node is gone', async () => {
      await fresh();
      await tree.set(createNode('/p', 'test.dir', {}));
      await tree.set(createNode('/p/a', 'test.item', {}));

      assert.equal(await tree.remove('/p/a'), true);
      assert.equal(await tree.get('/p/a'), undefined);
    });

    it('remove of a missing path returns false', async () => {
      await fresh();
      assert.equal(await tree.remove('/nope'), false);
    });

    // ── scanChildren (composed pipeline only — adapters covered in
    //    scan-children.contract.test.ts) ──

    if (t.scan) {
      it('is a TreeSource; scan yields direct children deterministically', async () => {
        await seedFamily();
        const source = asTreeSource(tree);

        const collect = async () => {
          const out: ChildEntry[] = [];
          for await (const e of source.scanChildren('/p')) out.push(e);
          return out;
        };

        const first = await collect();
        assert.deepEqual(first.map(e => e.node.$path).sort(), ['/p/a', '/p/b', '/p/c']);
        for (const e of first) assert.ok(typeof e.cursor === 'string' && e.cursor.length > 0);

        const second = await collect();
        assert.deepEqual(second.map(e => e.node.$path), first.map(e => e.node.$path));
      });

      it('scan cursor resumes strictly after the given entry', async () => {
        await seedFamily();
        const source = asTreeSource(tree);

        const all: ChildEntry[] = [];
        for await (const e of source.scanChildren('/p')) all.push(e);

        const rest: ChildEntry[] = [];
        for await (const e of source.scanChildren('/p', { after: all[0].cursor })) rest.push(e);

        assert.deepEqual(rest.map(e => e.node.$path), all.slice(1).map(e => e.node.$path));
      });

      it('scan rejects on a pre-aborted signal', async () => {
        await seedFamily();
        const source = asTreeSource(tree);
        const ac = new AbortController();
        ac.abort();

        await assert.rejects(async () => {
          for await (const _ of source.scanChildren('/p', { signal: ac.signal })) void _;
        });
      });
    }

    // ── watch (composed pipeline only) ──

    if (t.watch) {
      it('set on a new path emits a set event without $path in the body', async () => {
        await fresh();
        const w = pump(tree, { kind: 'path', path: '/p' });

        await tree.set(createNode('/p', 'test.item', { name: 'A' }));

        const ev = await w.take();
        assert.equal(ev.type, 'set');
        assert.equal(ev.type === 'set' && ev.path, '/p');
        assert.equal(ev.type === 'set' ? ev.node.name : undefined, 'A');
        assert.ok(ev.type === 'set' && !('$path' in ev.node));
        w.stop();
      });

      it('an overwriting set emits a patch diff carrying the stored $rev', async () => {
        await fresh();
        await tree.set(createNode('/p', 'test.item', { name: 'A' }));
        const w = pump(tree, { kind: 'path', path: '/p' });

        await tree.set(createNode('/p', 'test.item', { name: 'B' }));

        const ev = await w.take();
        assert.equal(ev.type, 'patch');
        if (ev.type === 'patch') {
          assert.ok(ev.patches.some(op => op[0] === 'r' && op[1] === 'name' && op[2] === 'B'));
          assert.equal(ev.rev, (await tree.get('/p'))?.$rev);
        }
        w.stop();
      });

      it('patch emits only its mutation ops — test ops are stripped', async () => {
        await fresh();
        await tree.set(createNode('/p', 'test.item', { name: 'A' }));
        const w = pump(tree, { kind: 'path', path: '/p' });

        await tree.patch('/p', [['t', 'name', 'A'], ['r', 'name', 'B']]);

        const ev = await w.take();
        assert.equal(ev.type, 'patch');
        if (ev.type === 'patch') assert.deepEqual(ev.patches, [['r', 'name', 'B']]);
        w.stop();
      });

      it('remove emits a remove event', async () => {
        await fresh();
        await tree.set(createNode('/biz', 'test.dir', {}));
        await tree.set(createNode('/biz/doc', 'test.item', {}));
        const w = pump(tree, { kind: 'path', path: '/biz/doc' });

        await tree.remove('/biz/doc');

        const ev = await w.take();
        assert.equal(ev.type, 'remove');
        w.stop();
      });

      it('events echo the writer opId as `by`; absent opId → no `by`', async () => {
        await fresh();
        const w = pump(tree, { kind: 'path', path: '/p' });

        await tree.set(createNode('/p', 'test.item', { name: 'A' }), { opId: 'op-1' });
        const tagged = await w.take();
        assert.equal(tagged.type === 'set' && tagged.by, 'op-1');

        await tree.set(createNode('/p', 'test.item', { name: 'B' }));
        const untagged = await w.take();
        assert.equal(untagged.type !== 'reconnect' && untagged.by, undefined);
        w.stop();
      });

      it('children scope yields direct children only', async () => {
        await fresh();
        const w = pump(tree, { kind: 'children', path: '/p' });

        await tree.set(createNode('/p', 'test.dir', {}));            // parent — excluded
        await tree.set(createNode('/p/a', 'test.item', {}));         // direct — included
        await tree.set(createNode('/p/a/deep', 'test.item', {}));    // grandchild — excluded
        await tree.set(createNode('/q', 'test.item', {}));           // sibling tree — excluded
        await tree.set(createNode('/p/sentinel', 'test.item', {}));  // direct — flushes the pipe

        const first = await w.take();
        const second = await w.take();
        assert.equal(first.type === 'set' && first.path, '/p/a');
        assert.equal(second.type === 'set' && second.path, '/p/sentinel');
        w.stop();
      });

      it('watch honors a pre-aborted signal by closing immediately', async () => {
        await fresh();
        const ac = new AbortController();
        ac.abort();
        const iter = tree.watch!({ kind: 'all' }, { signal: ac.signal })[Symbol.asyncIterator]();
        const r = await iter.next();
        assert.equal(r.done, true);
      });
    }
  });
}

// ── memory ──
suite({
  name: 'memory',
  setup: async () => createMemoryTree(),
  teardown: async () => {},
  readIsolation: true,
  watch: false,
  scan: false,
});

// ── fs (JSON-on-disk adapter) ──
{
  let dir: string | undefined;
  suite({
    name: 'fs',
    setup: async () => {
      dir = await mkdtemp(join(tmpdir(), 'treenix-conform-fs-'));
      return createFsTree(dir);
    },
    teardown: async () => {
      if (dir) {
        await rm(dir, { recursive: true, force: true });
        dir = undefined;
      }
    },
    readIsolation: true,
    watch: false,
    scan: false,
  });
}

// ── composed pipeline (createPipeline over a memory bootstrap) ──
suite({
  name: 'pipeline',
  setup: async () => createPipeline(createMemoryTree()).tree,
  teardown: async () => {},
  // tree/cache.ts serves live refs by contract — no read isolation here.
  readIsolation: false,
  watch: true,
  scan: true,
});
