// Mongo component-namespace boot-gate — contract tests against a mocked
// Collection (same approach as watch.test.ts; real-mongod integration lives
// outside the package). Pins the fail-closed contract:
//   - clean collection → stamped, served, zero writes
//   - bare-component candidates → boot throws, ZERO writes, no marker
//   - data snapshots carrying $type (audit before/after) → same throw (operator --stamp)
//   - marker at NS_VERSION → served without scan writes
//   - newer marker → throws (engine too old)
//   - migrateCollection(write) — the CLI --write path — renames correctly

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Collection } from 'mongodb';
import { NS_VERSION } from '@treenx/core/tree/migrate-component-namespace';
import { MARKER_PATH, ensureMigratedMongo, envNsMigratePolicy, migrateCollection } from './migrate';

type Doc = Record<string, unknown>;

function mockCol(docs: Doc[], markerV?: number) {
  const replaced: [unknown, Doc][] = [];
  let marker: Doc | null = markerV === undefined ? null : { _path: MARKER_PATH, v: markerV };

  const col = {
    findOne: async (filter: { _path: string }) =>
      filter._path === MARKER_PATH ? marker : null,
    find: () => ({
      async *[Symbol.asyncIterator]() {
        for (const d of docs) yield d;
      },
    }),
    replaceOne: async (filter: unknown, doc: Doc) => {
      replaced.push([filter, doc]);
    },
    updateOne: async (_f: unknown, u: { $set: { v: number } }) => {
      marker = { _path: MARKER_PATH, v: u.$set.v };
    },
  } as unknown as Collection;

  return { col, replaced, markerValue: () => marker?.v };
}

describe('ensureMigratedMongo (boot gate — fail closed)', () => {
  it('clean collection → stamped and served, zero writes', async () => {
    const { col, replaced, markerValue } = mockCol([
      { _id: 1, _path: '/plain', _type: 'dir', label: 'no components' },
      { _id: 2, _path: '/a', _type: 't', '#comp': { $type: 'y', v: 1 } },
    ]);

    await ensureMigratedMongo(col, 'test.nodes', () => {});
    assert.equal(replaced.length, 0);
    assert.equal(markerValue(), NS_VERSION);
  });

  it('bare component candidates → throws, zero writes, no marker', async () => {
    const { col, replaced, markerValue } = mockCol([
      { _id: 1, _path: '/auth/users/dev', _type: 't.user',
        groups: { $type: 'groups', list: ['admins'] } },
    ]);

    await assert.rejects(() => ensureMigratedMongo(col, 'test.users', () => {}), Error);
    assert.equal(replaced.length, 0);
    assert.equal(markerValue(), undefined);
  });

  it('snapshot fields carrying $type (audit before/after) → same throw, operator decides', async () => {
    const { col, replaced } = mockCol([
      { _id: 1, _path: '/audit/1', _type: 'audit.event', op: 'set', path: '/agents',
        before: { $type: 'ai.pool', $rev: 115 }, after: { $type: 'ai.pool', $rev: 116 } },
    ]);

    await assert.rejects(() => ensureMigratedMongo(col, 'test.audit', () => {}), Error);
    assert.equal(replaced.length, 0);
  });

  it('marker at NS_VERSION → served without scan writes', async () => {
    const { col, replaced } = mockCol(
      [{ _id: 1, _path: '/x', _type: 't', comp: { $type: 'y' } }],
      NS_VERSION,
    );

    await ensureMigratedMongo(col, 'test.users', () => {});
    assert.equal(replaced.length, 0);
  });

  it('newer marker than engine supports → throws', async () => {
    const { col } = mockCol([], NS_VERSION + 1);
    await assert.rejects(() => ensureMigratedMongo(col, 'test.users', () => {}), Error);
  });
});

// core-r096 follow-up: the rename-vs-stamp judgment is declared once (mount
// nsMigrate field or TREENIX_NS_MIGRATE env) and boot executes it — a deploy
// self-migrates instead of failing closed into an operator CLI session.
describe('ensureMigratedMongo — declared policy (auto-migrate on boot)', () => {
  it("policy 'rename': bare components migrated in place, stamped, served", async () => {
    const { col, replaced, markerValue } = mockCol([
      { _id: 1, _path: '/auth/users/dev', _type: 't.user',
        groups: { $type: 'groups', list: ['admins'] } },
    ]);

    await ensureMigratedMongo(col, 'test.users', () => {}, 'rename');

    assert.equal(replaced.length, 1);
    const [, doc] = replaced[0];
    assert.equal('groups' in doc, false);
    assert.deepEqual(doc['#groups'], { $type: 'groups', list: ['admins'] });
    assert.equal(markerValue(), NS_VERSION);
  });

  it("policy 'stamp': $type-carrying snapshots untouched, stamped, served", async () => {
    const { col, replaced, markerValue } = mockCol([
      { _id: 1, _path: '/audit/1', _type: 'audit.event', op: 'set', path: '/agents',
        before: { $type: 'ai.pool', $rev: 115 }, after: { $type: 'ai.pool', $rev: 116 } },
    ]);

    await ensureMigratedMongo(col, 'test.audit', () => {}, 'stamp');

    assert.equal(replaced.length, 0);
    assert.equal(markerValue(), NS_VERSION);
  });

  it('policy via TREENIX_NS_MIGRATE env glob reaches the gate', async () => {
    const { col, replaced, markerValue } = mockCol([
      { _id: 1, _path: '/auth/users/dev', _type: 't.user',
        groups: { $type: 'groups', list: ['admins'] } },
    ]);

    const saved = process.env.TREENIX_NS_MIGRATE;
    process.env.TREENIX_NS_MIGRATE = '*.audit_events:stamp,*.users:rename';
    try {
      await ensureMigratedMongo(col, 'treenix.users', () => {});
    } finally {
      if (saved === undefined) delete process.env.TREENIX_NS_MIGRATE;
      else process.env.TREENIX_NS_MIGRATE = saved;
    }

    assert.equal(replaced.length, 1);
    assert.equal(markerValue(), NS_VERSION);
  });
});

describe('envNsMigratePolicy', () => {
  it('matches label against globs, later entries win', () => {
    assert.equal(envNsMigratePolicy('treenix.users', '*.users:rename'), 'rename');
    assert.equal(envNsMigratePolicy('treenix.audit_events', '*.users:rename,*.audit_events:stamp'), 'stamp');
    assert.equal(envNsMigratePolicy('treenix.users', '*:stamp,*.users:rename'), 'rename');
    assert.equal(envNsMigratePolicy('treenix.other', '*.users:rename'), undefined);
    assert.equal(envNsMigratePolicy('treenix.users', undefined), undefined);
  });

  it('malformed entries throw instead of silently stranding collections', () => {
    assert.throws(() => envNsMigratePolicy('treenix.users', '*.users:oops'));
    assert.throws(() => envNsMigratePolicy('treenix.users', 'no-colon'));
    assert.throws(() => envNsMigratePolicy('treenix.users', ':rename'));
  });
});

describe('migrateCollection (CLI --write path)', () => {
  it('renames bare component keys, leaves plain docs alone', async () => {
    const { col, replaced } = mockCol([
      { _id: 1, _path: '/auth/users/dev', _type: 't.user', status: 'active',
        groups: { $type: 'groups', list: ['admins'] } },
      { _id: 2, _path: '/plain', _type: 'dir', label: 'untouched' },
    ]);

    const s = await migrateCollection(col, 'test.users', true, () => {});

    assert.equal(s.migrated, 1);
    assert.equal(s.renames, 1);
    assert.equal(replaced.length, 1);
    const [filter, doc] = replaced[0];
    assert.deepEqual(filter, { _id: 1 });
    assert.equal('groups' in doc, false);
    assert.deepEqual(doc['#groups'], { $type: 'groups', list: ['admins'] });
    assert.equal(doc._path, '/auth/users/dev');
    assert.equal(doc.status, 'active');
  });
});
