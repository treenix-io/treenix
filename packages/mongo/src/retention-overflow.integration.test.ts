import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { readJournalImages } from '@treenx/core/kernel/journal';
import { position, scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import type { JournalEntry, StoreCommit } from '@treenx/core/kernel/types';
import { createMongoStore } from '#store';

it('promotes individually bounded images beyond one BSON root while preserving exact retained history', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `retention_overflow_${randomUUID().replaceAll('-', '')}`;
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo', journalRetentionMs: 100 });
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const seed = { ...storeCommit(1, Array.from({ length: 36 }, (_, index) =>
      storedNode(`/n${index}`, { payload: 'x'.repeat(512 * 1024), value: 1 }))),
      acceptedAt: 1000, journalRetentionMs: 100 };
    await store.commit(seed);
    const before = seed.writes.map(write => write.node);
    const next = { ...storeCommit(2, before.map(node => ({ ...node, value: 2 })), before),
      acceptedAt: 1901, journalRetentionMs: 100 };
    const entries: JournalEntry[] = next.record.entries.map(entry => {
      assert.equal(entry.change.t, 'update');
      if (entry.change.t !== 'update') throw new KernelError('INVALID', 'Expected update fixture');
      return { ...entry, change: { t: 'update', delta: entry.change.delta } };
    });
    await store.commit({ ...next, record: { ...next.record, entries } });
    let seq = 3;
    do {
      assert.ok(seq < 30);
      const commit: StoreCommit = { pos: position(seq), writerEpoch: 1, acceptedAt: 2000,
        journalRetentionMs: 100, writes: [],
        record: { pos: position(seq++), kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [],
          maintenance: { journalBefore: 1900, decisionBefore: 1500 } },
        maintenanceLimits: { changeSet: 100, budget: { ...scanBudget(), deadline: Date.now() + 5000 } } };
      await store.commit(commit);
    } while (store.maintenancePending === true);

    const root = await client.db(db).collection('nodes.__journal').findOne({ '_seq': 2 });
    assert.ok(root);
    assert.equal(root._entryOverrides, true);
    assert.ok(root._logicalBytes > 16 * 1024 * 1024);
    assert.ok(JSON.stringify(root).length < 1024 * 1024);
    await assert.rejects(store.scan({ range: { journal: '/' }, budget: scanBudget() }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    for (const write of next.writes) {
      assert.ok(write.node !== null);
      const id = write.node.$id;
      const retained = (await store.scan({ range: { journal: '/', accept: entry => entry.address.id === id },
        budget: scanBudget() })).items;
      const images = readJournalImages(retained, { pos: next.pos, id });
      assert.deepEqual(images.before, before.find(node => node.$id === id));
      assert.deepEqual(images.after, write.node);
    }
  } finally {
    await store.close();
    await client.close();
  }
});
