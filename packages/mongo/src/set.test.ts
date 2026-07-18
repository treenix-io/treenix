// mongoSet unit tests against a mocked Collection (same approach as
// watch.test.ts; real-mongod integration lives outside the package).
// Pins the ns6p.4 invariant-24 rev contract at the driver boundary:
//   - blind set = TRUE upsert, filter carries NO _rev, written _rev is
//     computed server-side from the STORED doc (advance-from-stored);
//   - OCC set keeps its {_path, _rev} filter and CONFLICT semantics;
//   - upsert race (11000) retries once onto the now-existing doc.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Collection } from 'mongodb';
import { OpError } from '@treenx/core/errors';
import { mongoSet } from './index';

type Captured = { filter: Record<string, unknown>; update: unknown; options: Record<string, unknown> };

function mockCol(handlers: {
  findOneAndUpdate?: (c: Captured) => unknown;
  findOneAndReplace?: (c: Captured) => unknown;
}) {
  const calls: { op: string; captured: Captured }[] = [];
  const col = {
    findOneAndUpdate: async (filter: Record<string, unknown>, update: unknown, options: Record<string, unknown>) => {
      const captured = { filter, update, options };
      calls.push({ op: 'findOneAndUpdate', captured });
      return handlers.findOneAndUpdate!(captured);
    },
    findOneAndReplace: async (filter: Record<string, unknown>, update: unknown, options: Record<string, unknown>) => {
      const captured = { filter, update, options };
      calls.push({ op: 'findOneAndReplace', captured });
      return handlers.findOneAndReplace!(captured);
    },
  } as unknown as Collection;
  return { col, calls };
}

describe('mongoSet — rev contract (ns6p.4 invariant 24)', () => {
  it('blind set over a stored doc: no rev filter, upsert, written rev advances from STORED (47 → 48)', async () => {
    const stored = { _id: 'x', _path: '/p', _type: 'item', name: 'old', _rev: 47 };
    const { col, calls } = mockCol({ findOneAndUpdate: () => stored });

    const node = { $path: '/p', $type: 'item', name: 'new' };
    const receipt = await mongoSet(col, node);

    const { filter, update, options } = calls[0].captured;
    assert.deepEqual(filter, { _path: '/p' }, 'blind set carries NO _rev filter — last write wins');
    assert.equal(options.upsert, true);
    assert.equal(options.returnDocument, 'before');
    // The update pipeline IS the wire contract with the server: _rev computed
    // from the stored doc ($ifNull 0 covers upsert-create), node fields shielded
    // by $literal from expression parsing.
    assert.deepEqual(update, [{
      $replaceWith: {
        $mergeObjects: [
          { $literal: { _path: '/p', _type: 'item', name: 'new' } },
          { _rev: { $add: [{ $ifNull: ['$_rev', 0] }, 1] } },
        ],
      },
    }]);

    assert.equal(node.$rev, 48, 'caller-visible rev advances from stored');
    assert.equal(receipt.changes[0].before?.$rev, 47);
    assert.equal(receipt.changes[0].after.$rev, 48);
    assert.equal(receipt.changes[0].before?.name, 'old');
  });

  it('blind set on a fresh path: upsert creates at rev 1', async () => {
    const { col } = mockCol({ findOneAndUpdate: () => null });

    const node = { $path: '/fresh', $type: 'item' };
    const receipt = await mongoSet(col, node);

    assert.equal(node.$rev, 1);
    assert.equal(receipt.changes[0].before, null);
    assert.equal(receipt.changes[0].after.$rev, 1);
  });

  it('upsert race (11000) retries once onto the now-existing doc', async () => {
    let attempt = 0;
    const { col, calls } = mockCol({
      findOneAndUpdate: () => {
        if (++attempt === 1) throw Object.assign(new Error('dup'), { code: 11000 });
        return { _id: 'y', _path: '/raced', _type: 'item', _rev: 1 };
      },
    });

    const node = { $path: '/raced', $type: 'item' };
    await mongoSet(col, node);

    assert.equal(calls.length, 2);
    assert.equal(node.$rev, 2, 'loser of the race lands on top of the winner');
  });

  it('OCC set keeps the {_path, _rev} filter and writes incoming+1 (= stored+1 by the filter)', async () => {
    const stored = { _id: 'z', _path: '/p', _type: 'item', _rev: 47 };
    const { col, calls } = mockCol({ findOneAndReplace: () => stored });

    const node = { $path: '/p', $type: 'item', $rev: 47 };
    const receipt = await mongoSet(col, node);

    const { filter, update } = calls[0].captured;
    assert.deepEqual(filter, { _path: '/p', _rev: 47 });
    assert.equal((update as { _rev: number })._rev, 48, 'replacement doc carries stored+1');
    assert.equal(receipt.changes[0].after.$rev, 48);
  });

  it('OCC mismatch → CONFLICT, nothing reported', async () => {
    const { col } = mockCol({ findOneAndReplace: () => null });

    await assert.rejects(
      mongoSet(col, { $path: '/p', $type: 'item', $rev: 40 }),
      (e: unknown) => e instanceof OpError && e.code === 'CONFLICT',
    );
  });
});
