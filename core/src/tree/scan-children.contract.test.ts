// Contract test suite for TreeSource.scanChildren — runs against every
// concrete adapter (memory, fs, mimefs). Adapter-specific behavior lives
// in the corresponding *.test.ts files; this file checks ONLY the
// scanChildren contract that every adapter MUST satisfy.

import { createNode, register } from '#core';
import { OpError } from '#errors';
import { clearRegistry } from '#testing';
import { withMounts } from '#mount';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { createMemoryTree, type ChildEntry, type Tree, type TreeSource } from './index';

async function collect(iter: AsyncIterable<ChildEntry>): Promise<ChildEntry[]> {
  const out: ChildEntry[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

interface Factory {
  name: string;
  setup: () => Promise<TreeSource>;
  teardown: () => Promise<void>;
}

function suite(factory: Factory) {
  describe(`scanChildren contract: ${factory.name}`, () => {
    let tree: TreeSource;

    afterEach(async () => {
      await factory.teardown();
    });

    async function seed(paths: string[], type = 'item') {
      tree = await factory.setup();
      for (const p of paths) await tree.set(createNode(p, type));
      return tree;
    }

    it('empty source yields nothing', async () => {
      tree = await factory.setup();
      const entries = await collect(tree.scanChildren('/nonexistent'));
      assert.deepEqual(entries, []);
    });

    it('yields direct children in deterministic order', async () => {
      tree = await seed(['/p', '/p/c', '/p/a', '/p/b'], 'item');
      const entries = await collect(tree.scanChildren('/p'));
      const paths = entries.map(e => e.node.$path);
      assert.equal(paths.length, 3);
      // Same scan twice yields same order
      const again = await collect(tree.scanChildren('/p'));
      assert.deepEqual(again.map(e => e.node.$path), paths);
    });

    it('depth=2 includes grandchildren', async () => {
      tree = await seed(['/p', '/p/a', '/p/a/x', '/p/b']);
      const entries = await collect(tree.scanChildren('/p', { depth: 2 }));
      const paths = entries.map(e => e.node.$path).sort();
      assert.deepEqual(paths, ['/p/a', '/p/a/x', '/p/b']);
    });

    it('depth=-1 yields the full subtree in $path ASC order', async () => {
      tree = await seed(['/p', '/p/b', '/p/b/y', '/p/a', '/p/a/x', '/p/a/x/deep']);
      const entries = await collect(tree.scanChildren('/p', { depth: -1 }));
      assert.deepEqual(
        entries.map(e => e.node.$path),
        ['/p/a', '/p/a/x', '/p/a/x/deep', '/p/b', '/p/b/y'],
      );
    });

    it('default depth is 1', async () => {
      tree = await seed(['/p', '/p/a', '/p/a/x']);
      const entries = await collect(tree.scanChildren('/p'));
      assert.deepEqual(entries.map(e => e.node.$path), ['/p/a']);
    });

    it('after: cursor is exclusive', async () => {
      tree = await seed(['/p', '/p/a', '/p/b', '/p/c']);
      const all = await collect(tree.scanChildren('/p'));
      assert.equal(all.length, 3);
      const rest = await collect(tree.scanChildren('/p', { after: all[0].cursor }));
      // Cursor after the first entry excludes that entry.
      assert.equal(rest.length, 2);
      assert.ok(!rest.some(e => e.node.$path === all[0].node.$path));
    });

    it('page concatenation equals full scan (no dup, no skip)', async () => {
      tree = await seed(['/p', '/p/a', '/p/b', '/p/c', '/p/d', '/p/e']);
      const all = await collect(tree.scanChildren('/p'));
      assert.equal(all.length, 5);

      const page1: ChildEntry[] = [];
      for await (const e of tree.scanChildren('/p')) {
        page1.push(e);
        if (page1.length === 2) break;
      }
      const page2 = await collect(tree.scanChildren('/p', { after: page1[1].cursor }));

      assert.deepEqual(
        [...page1, ...page2].map(e => e.node.$path),
        all.map(e => e.node.$path),
      );
    });

    it('early break does not corrupt subsequent scans', async () => {
      tree = await seed(['/p', '/p/a', '/p/b', '/p/c']);
      let n = 0;
      for await (const _ of tree.scanChildren('/p')) {
        n++;
        if (n === 1) break;
      }
      assert.equal(n, 1);
      const fresh = await collect(tree.scanChildren('/p'));
      assert.equal(fresh.length, 3);
    });

    it('async iterator return() runs cleanup (no unhandled rejections)', async () => {
      tree = await seed(['/p', '/p/a', '/p/b', '/p/c']);
      const it = tree.scanChildren('/p')[Symbol.asyncIterator]();
      const first = await it.next();
      assert.equal(first.done, false);
      // Explicit return — adapter cleanup paths run.
      const ret = await it.return!();
      assert.equal(ret.done, true);
    });

    it('AbortSignal interrupts pending scan', async () => {
      tree = await seed(['/p', '/p/a', '/p/b', '/p/c', '/p/d']);
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(
        () => collect(tree.scanChildren('/p', { signal: ac.signal })),
      );
    });

    it('cursor is a non-empty string', async () => {
      tree = await seed(['/p', '/p/a']);
      const entries = await collect(tree.scanChildren('/p'));
      assert.equal(entries.length, 1);
      assert.equal(typeof entries[0].cursor, 'string');
      assert.ok(entries[0].cursor.length > 0);
    });
  });
}

// ── memory ──
suite({
  name: 'memory',
  setup: async () => createMemoryTree(),
  teardown: async () => {},
});

// ── fs (JSON-on-disk adapter) ──
{
  let dir: string | undefined;
  suite({
    name: 'fs',
    setup: async () => {
      dir = await mkdtemp(join(tmpdir(), 'treenix-scan-fs-'));
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

// mimefs is covered separately in mimefs.test.ts — it uses a different
// path model (extensions are preserved on $path; nodes are real files).

// ── mount Tree-only fallback: cyclic-cursor guard (core-anz4.16) ──
// The withMounts.scanChildren fallback pages a legacy Tree-only adapter via
// nextCursor. A misbehaving adapter that returns a repeating/cyclic nextCursor
// must make the scan REJECT loudly, never loop forever.
describe('scanChildren mount fallback: cyclic nextCursor', () => {
  afterEach(() => clearRegistry());

  it('rejects when a Tree-only adapter returns a repeating nextCursor', async () => {
    const stuck: Tree = {
      async get() { return undefined; },
      async getChildren() {
        return { items: [createNode('/users/alice', 'item')], total: 1, nextCursor: 'STUCK' };
      },
      async set() { return { changes: [] }; },
      async remove() { return { changes: [] }; },
      async patch() { return { changes: [] }; },
    };
    register('test.mount.cyclic', 'mount', () => stuck);
    const rootStore = createMemoryTree();
    await rootStore.set(
      createNode('/users', 'collection', {}, { mount: { $type: 'test.mount.cyclic' } }),
    );
    const ms = withMounts(rootStore);
    await assert.rejects(
      async () => { for await (const _ of ms.scanChildren!('/users')) { /* drain */ } },
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });
});
