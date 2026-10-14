import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { readJournalImages } from '@treenx/core/kernel/journal';
import { position, scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import type { JournalEntry, StoreCommit } from '@treenx/core/kernel/types';
import { createMongoStore, type MongoStore } from '#store';

/** Preserve compact deltas so retention must build actual retained anchors. */
function compact(commit: StoreCommit): StoreCommit {
  const entries: JournalEntry[] = commit.record.entries.map((entry) =>
    entry.change.t === 'update'
      ? { ...entry, change: { t: 'update', delta: entry.change.delta } }
      : entry,
  );
  return { ...commit, record: { ...commit.record, entries } };
}

/** Each batch carries a fresh deadline and the actual declared node/change-set caps. */
function maintenance(seq: number, bytes = 8 * 1024 * 1024): StoreCommit {
  return {
    pos: position(seq),
    writerEpoch: 1,
    acceptedAt: 2000,
    journalRetentionMs: 100,
    writes: [],
    record: {
      pos: position(seq),
      kind: 'kernel',
      executor: 'kernel',
      caller: 'kernel',
      entries: [],
      maintenance: { journalBefore: 1900, decisionBefore: 1500 },
    },
    maintenanceLimits: {
      changeSet: 1,
      budget: { ...scanBudget(), bytes, deadline: Date.now() + 5000 },
    },
  };
}

it('compacts through owning transactions and resumes exact retained anchors after a cold reopen', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `retention_${randomUUID().replaceAll('-', '')}`;
  const options = { uri, db, collection: 'nodes', domain: 'mongo', journalRetentionMs: 100 };
  let store: MongoStore = await createMongoStore(options);
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const seed = {
      ...storeCommit(1, [storedNode('/a', { value: 1 }), storedNode('/b', { value: 1 })]),
      acceptedAt: 1000,
      journalRetentionMs: 100,
    };
    const decision = {
      opId: { epoch: 'retention', time: 1999, nonce: 'old' },
      requestHash: 'seed',
      outcome: { value: 1 },
    };
    await store.commit({ ...seed, record: { ...seed.record, decision } });
    const before = seed.writes.map((write) => write.node);
    const next = compact({
      ...storeCommit(
        2,
        before.map((node) => ({ ...node, value: 2 })),
        before,
      ),
      acceptedAt: 1901,
      journalRetentionMs: 100,
    });
    await store.commit({
      ...next,
      record: {
        ...next.record,
        entries: next.record.entries.map((entry, index) =>
          index === 1
            ? { ...entry, change: { t: 'reconcile', after: next.writes[index].node } }
            : entry,
        ),
      },
    });
    await store.commit(maintenance(3));
    assert.equal(store.maintenancePending, true);
    const control = client.db(db).collection('nodes.__control');
    const progress = await control.findOne({ _id: 'writer' });
    assert.equal(progress?.retentionCursor.ordinal, 1);
    await store.close();
    store = await createMongoStore(options);
    assert.equal(store.maintenancePending, true);
    let seq = 4;
    while (store.maintenancePending === true) {
      assert.ok(seq < 16);
      await store.commit(maintenance(seq++));
    }
    const retained = (await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items;
    for (const write of next.writes) {
      assert.ok(write.node !== null);
      const images = readJournalImages(retained, { pos: next.pos, id: write.node.$id });
      assert.deepEqual(
        images.before,
        before.find((node) => node.$id === write.node?.$id),
      );
      assert.deepEqual(images.after, write.node);
    }
    const oldHeader = retained.find((record) => record.pos.seq === 1);
    assert.ok(oldHeader);
    assert.deepEqual(oldHeader.entries, []);
    assert.deepEqual(oldHeader.decision, decision);
    assert.deepEqual(
      (await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      next.writes.map((write) => write.node),
    );
    assert.ok(
      retained.some(
        (record) =>
          record.kind === 'kernel' &&
          record.executor === 'kernel' &&
          record.caller === 'kernel' &&
          record.entries.length === 0 &&
          record.maintenance !== undefined,
      ),
    );
    assert.equal(store.journalRetentionBoundary, 1900);
    assert.equal(store.journalRetentionClock, 2000);
    assert.equal((await control.findOne({ _id: 'writer' }))?.retentionCursor, undefined);
  } finally {
    await store.close();
    await client.close();
  }
});

it('rejects an unfit first maintenance entry without accepting an unchanged progress cursor', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `retention_budget_${randomUUID().replaceAll('-', '')}`;
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo' });
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const seed = {
      ...storeCommit(1, [storedNode('/a', { payload: 'x'.repeat(8192) })]),
      acceptedAt: 1000,
      journalRetentionMs: 100,
    };
    await store.commit(seed);
    await assert.rejects(
      store.commit(maintenance(2, 4096)),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET',
    );
    assert.equal(
      (await client.db(db).collection('nodes.__control').findOne({ _id: 'writer' }))
        ?.retentionCursor,
      undefined,
    );
    assert.equal(await client.db(db).collection('nodes.__journal').countDocuments(), 1);
    assert.deepEqual(
      (await store.scan({ range: { node: '/a' }, budget: scanBudget() })).items,
      seed.writes.map((write) => write.node),
    );
  } finally {
    await store.close();
    await client.close();
  }
});
