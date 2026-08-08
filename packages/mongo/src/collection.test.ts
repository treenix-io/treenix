// createCollectionTree unit tests against a mocked Collection (same approach as
// set.test.ts; real-mongod integration lives outside the package).
// Contract under test: read-only, foreign docs surfaced as-is with synthesized
// $path/$type, deterministic (sortField, _id) order with resumable cursors.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Collection, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { OpError } from '@treenx/core/errors';

import { createCollectionTree } from './collection';

// ── Minimal in-memory Collection: find/findOne over $and/$or/eq/$gt/$lt/$gte ──

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof ObjectId ? a.toHexString() : a;
  const bv = b instanceof ObjectId ? b.toHexString() : b;
  if (av === bv) return 0;
  return (av as never) < (bv as never) ? -1 : 1;
}

function matches(doc: Document, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and') {
      if (!(v as Record<string, unknown>[]).every((f) => matches(doc, f))) return false;
      continue;
    }
    if (k === '$or') {
      if (!(v as Record<string, unknown>[]).some((f) => matches(doc, f))) return false;
      continue;
    }
    const val = doc[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ObjectId)) {
      for (const [op, ov] of Object.entries(v)) {
        if (op === '$gt' && !(cmp(val, ov) > 0)) return false;
        if (op === '$lt' && !(cmp(val, ov) < 0)) return false;
        if (op === '$gte' && !(cmp(val, ov) >= 0)) return false;
        if (op === '$lte' && !(cmp(val, ov) <= 0)) return false;
      }
    } else if (cmp(val, v) !== 0) return false;
  }
  return true;
}

function mockCollection(docs: Document[]): Collection {
  return {
    async findOne(filter: Record<string, unknown>) {
      return docs.find((d) => matches(d, filter)) ?? null;
    },
    find(filter: Record<string, unknown>) {
      let out = docs.filter((d) => matches(d, filter));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const keys = Object.entries(spec);
          out = [...out].sort((a, b) => {
            for (const [k, dir] of keys) {
              const c = cmp(a[k], b[k]);
              if (c !== 0) return c * dir;
            }
            return 0;
          });
          return cursor;
        },
        limit(n: number) {
          out = out.slice(0, n);
          return cursor;
        },
        batchSize() {
          return cursor;
        },
        async toArray() {
          return out;
        },
        async close() {},
        async *[Symbol.asyncIterator]() {
          yield* out;
        },
      };
      return cursor;
    },
  } as unknown as Collection;
}

const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));

const DOCS: Document[] = [
  { _id: oid(1), slug: 'btc-1', asset: 'btc', closeTs: 100, flip: false, volumeUsd: 500 },
  { _id: oid(2), slug: 'btc-2', asset: 'btc', closeTs: 200, flip: true, volumeUsd: 1500 },
  { _id: oid(3), slug: 'eth-1', asset: 'eth', closeTs: 200, flip: false, volumeUsd: 900 },
  { _id: oid(4), slug: 'eth-2', asset: 'eth', closeTs: 300, flip: true, volumeUsd: 2500 },
];

const TYPE = 'acme.market';

function makeTree(docs = DOCS) {
  return createCollectionTree(mockCollection(docs), { keyField: 'slug', type: TYPE, sort: { closeTs: -1 } });
}

const isCode = (code: string) => (e: unknown) => (e as OpError).code === code;

describe('createCollectionTree', () => {
  it('get("/") returns a dir node', async () => {
    const node = await makeTree().get('/');
    assert.deepEqual(node, { $path: '/', $type: 'dir' });
  });

  it('get("/<key>") synthesizes $path/$type and drops _id, keeping fields as-is', async () => {
    const node = await makeTree().get('/btc-2');
    assert.ok(node);
    assert.equal(node.$path, '/btc-2');
    assert.equal(node.$type, TYPE);
    assert.equal(node.closeTs, 200);
    assert.equal(node.flip, true);
    assert.ok(!('_id' in node));
  });

  it('get of missing key and nested path returns undefined', async () => {
    const tree = makeTree();
    assert.equal(await tree.get('/nope'), undefined);
    assert.equal(await tree.get('/btc-1/deeper'), undefined);
  });

  it('getChildren orders by configured sort desc, _id tiebreak', async () => {
    const page = await makeTree().getChildren('/');
    assert.deepEqual(page.items.map((n) => n.$path), ['/eth-2', '/eth-1', '/btc-2', '/btc-1']);
  });

  it('getChildren applies query; matching $type condition is dropped', async () => {
    const page = await makeTree().getChildren('/', { query: { $type: TYPE, flip: true } });
    assert.deepEqual(page.items.map((n) => n.$path), ['/eth-2', '/btc-2']);
  });

  it('getChildren with mismatched $type is provably empty', async () => {
    const page = await makeTree().getChildren('/', { query: { $type: 'other.type' } });
    assert.deepEqual(page.items, []);
  });

  it('paginates without overlap across a sort-value tie', async () => {
    const tree = makeTree();
    const p1 = await tree.getChildren('/', { limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.ok(p1.nextCursor);
    const p2 = await tree.getChildren('/', { limit: 2, cursor: p1.nextCursor });
    assert.equal(p2.nextCursor, undefined);
    const all = [...p1.items, ...p2.items].map((n) => n.$path);
    assert.deepEqual(all, ['/eth-2', '/eth-1', '/btc-2', '/btc-1']);
  });

  it('scanChildren resumes strictly after a cursor', async () => {
    const tree = makeTree();
    const entries = [];
    for await (const e of tree.scanChildren('/')) entries.push(e);
    assert.equal(entries.length, 4);

    const resumed = [];
    for await (const e of tree.scanChildren('/', { after: entries[1].cursor })) resumed.push(e.node.$path);
    assert.deepEqual(resumed, ['/btc-2', '/btc-1']);
  });

  it('limitHint is a batching hint, not a cap — scan yields past it', async () => {
    const all = [];
    for await (const e of makeTree().scanChildren('/', { limitHint: 2 })) all.push(e.node.$path);
    assert.equal(all.length, 4);
  });

  it('rejects forbidden operators and system-field queries', async () => {
    const tree = makeTree();
    await assert.rejects(() => tree.getChildren('/', { query: { $where: '1' } }), isCode('BAD_REQUEST'));
    await assert.rejects(() => tree.getChildren('/', { query: { flip: { $where: '1' } } }), isCode('BAD_REQUEST'));
    await assert.rejects(() => tree.getChildren('/', { query: { $path: '/x' } }), isCode('BAD_REQUEST'));
  });

  it('is read-only: set/remove/patch deny, docs stay untouched', async () => {
    // Shallow copies: same ObjectId instances (structuredClone breaks them), field mutation still detected.
    const docs = DOCS.map((d) => ({ ...d }));
    const tree = createCollectionTree(mockCollection(docs), { keyField: 'slug', type: TYPE, sort: { closeTs: -1 } });

    await assert.rejects(() => tree.set({ $path: '/btc-1', $type: TYPE }), isCode('FORBIDDEN'));
    await assert.rejects(() => tree.remove('/btc-1'), isCode('FORBIDDEN'));
    await assert.rejects(() => tree.patch('/btc-1', []), isCode('FORBIDDEN'));

    assert.deepEqual(docs, DOCS);
  });

  it('baseQuery pre-filters every read', async () => {
    const tree = createCollectionTree(mockCollection(DOCS), { keyField: 'slug', type: TYPE, sort: { closeTs: -1 }, baseQuery: { asset: 'btc' } });
    const page = await tree.getChildren('/');
    assert.deepEqual(page.items.map((n) => n.$path), ['/btc-2', '/btc-1']);
    assert.equal(await tree.get('/eth-1'), undefined);
  });

  it('keyField "_id" uses the hex id as node name', async () => {
    const tree = createCollectionTree(mockCollection(DOCS), { keyField: '_id', type: TYPE, sort: { closeTs: -1 } });
    const node = await tree.get(`/${oid(3).toHexString()}`);
    assert.ok(node);
    assert.equal(node.slug, 'eth-1');
    assert.equal(await tree.get('/not-a-hex-id'), undefined);
  });
});
