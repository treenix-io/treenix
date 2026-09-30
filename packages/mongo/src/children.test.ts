// mongoGetChildren against an in-memory collection: cursor paging in _path order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ChildrenCollection, mongoGetChildren } from './index';

type Doc = Record<string, unknown>;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return (cond as Doc[]).every((f) => matches(doc, f));
    const value = doc[key];
    if (cond instanceof RegExp) return typeof value === 'string' && cond.test(value);
    if (cond && typeof cond === 'object' && '$gt' in cond) return String(value) > String(cond.$gt);
    return value === cond;
  });
}

function collection(docs: Doc[]): ChildrenCollection & { finds: number } {
  const col = {
    finds: 0,
    find(filter: Doc) {
      col.finds++;
      let rows = docs.filter((d) => matches(d, filter));
      const cursor = {
        sort() {
          rows = [...rows].sort((a, b) => (String(a._path) < String(b._path) ? -1 : 1));
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        async toArray() {
          return rows;
        },
      };
      return cursor;
    },
  };
  return col;
}

const child = (path: string, kind = 'x') => ({ _path: path, _type: 'item', kind });

const DOCS = [
  child('/p/e'), child('/p/a'), child('/p/c'), child('/p/b', 'y'), child('/p/d'),
  child('/p/a/deep'), child('/q/a'),
];

/** Follows nextCursor to the end; a cursor that does not advance stops the walk after one page per doc. */
async function allPages(col: ChildrenCollection, limit: number, query?: Doc): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await mongoGetChildren(col, '/p', { limit, cursor, query });
    pages.push(page.items.map((n) => n.$path));
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages.length <= DOCS.length);
  return pages;
}

describe('mongoGetChildren', () => {
  it('pages through the direct children in path order, each child once', async () => {
    assert.deepEqual(await allPages(collection(DOCS), 2), [['/p/a', '/p/b'], ['/p/c', '/p/d'], ['/p/e']]);
  });

  it('a page ending on the last child carries no nextCursor', async () => {
    const col = collection(DOCS);
    assert.deepEqual(await allPages(col, 5), [['/p/a', '/p/b', '/p/c', '/p/d', '/p/e']]);
    assert.equal(col.finds, 1);
  });

  it('the cursor resumes within a query', async () => {
    assert.deepEqual(await allPages(collection(DOCS), 2, { kind: 'x' }), [['/p/a', '/p/c'], ['/p/d', '/p/e']]);
  });

  it('without a limit one page holds every child', async () => {
    const page = await mongoGetChildren(collection(DOCS), '/p');
    assert.equal(page.items.length, 5);
    assert.equal(page.nextCursor, undefined);
  });
});
