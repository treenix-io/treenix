import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { BSON, MongoClient } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { scanBudget, storeCommit } from '@treenx/core/kernel/testing';
import { createMongoStore } from '#store';
import { FRAGMENT_HEAD_PROJECTION, type FragmentJournalRoot } from '#journal-records';

it('bounds empty fragment roots and rejects a corrupt intake marker during scans and reopening', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI; assert.ok(uri);
  const db = `empty_fragment_${randomUUID().replaceAll('-', '')}`;
  const options = { uri, db, collection: 'nodes', domain: 'mongo' };
  const store = await createMongoStore(options);
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const seed = storeCommit(1, []);
    const record = { ...seed.record, decision: { opId: { epoch: 'epoch', time: 1, nonce: 'nonce' },
      requestHash: 'request', stream: { executor: 'u:actor' as const, target: 'target' },
      outcome: { value: 'x'.repeat(9 * 1024 * 1024) } } };
    await store.commit({ ...seed, record });
    const headers = client.db(db).collection<FragmentJournalRoot>('nodes.__journal.__headers');
    assert.equal(await headers.countDocuments({ entryCount: 0 }), 1);
    await headers.updateOne({}, { $set: { unrelated: 'y'.repeat(7 * 1024 * 1024) } });
    const projected = await headers.findOne({}, { projection: FRAGMENT_HEAD_PROJECTION });
    assert.ok(projected);
    assert.ok(BSON.serialize(projected).length < 4096);
    const budget = () => ({ ...scanBudget(), bytes: 16 * 1024 * 1024 });
    assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: budget() })).items, [record]);
    await client.db(db).collection('nodes.__journal.__headers').updateOne({},
      { $unset: { unrelated: '' }, $set: { hasIntake: 'z'.repeat(7 * 1024 * 1024) } });
    const corrupt = await headers.findOne({}, { projection: FRAGMENT_HEAD_PROJECTION });
    assert.ok(corrupt);
    assert.equal(corrupt.hasIntake, null);
    assert.ok(BSON.serialize(corrupt).length < 4096);
    await assert.rejects(store.scan({ range: { journalHead: 'position' }, budget: budget() }),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID');
  } finally { await store.close(); await client.close(); }
  await assert.rejects(createMongoStore(options),
    (error: unknown) => error instanceof KernelError && error.code === 'INVALID');
});
