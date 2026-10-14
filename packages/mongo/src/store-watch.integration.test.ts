import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { it } from 'node:test';
import { ObjectId } from 'mongodb';
import { scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import { getSharedClient } from '#index';
import { journalIdentity } from '#journal-records';
import { openMongoTransactionOwner } from '#owner';

it('resolves a cold ObjectId delete after its canonical history has expired', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI,
    artifact = process.env.NATIVE_MONGO_TEST_ARTIFACT;
  assert.ok(uri);
  assert.ok(artifact);
  const database = `cold_delete_${randomUUID().replaceAll('-', '')}`;
  const options = {
    uri,
    domain: database,
    instance: 'test',
    journalDb: database,
    journalCollection: 'journal',
  };
  const pool = getSharedClient(uri, true);
  const original = await openMongoTransactionOwner(options);
  const seeded = await original.openCollection({
    db: database,
    collection: 'nodes',
    logicalBase: '/',
  });
  const node = storedNode('/a');
  const first = storeCommit(1, [node], [], original.resources.writerEpoch);
  await seeded.commit(first);
  await seeded.commit(storeCommit(2, [storedNode('/b')], [], original.resources.writerEpoch));
  await seeded.close();
  await original.close();

  const db = pool.client.db(database),
    position = journalIdentity(first.pos);
  const retired = [];
  for (const [name, query] of [
    ['journal', { _position: position }],
    ['journal.__headers', { _position: position }],
    ['journal.__entries', { position }],
    ['journal.__fragments', { position }],
  ] as const) {
    const ids = await db
      .collection<{ readonly _id: string }>(name)
      .find(query, { projection: { _id: 1 } })
      .toArray();
    retired.push({ name, ids: ids.map((value) => value._id) });
  }
  await writeFile(artifact, JSON.stringify({ database, position, retired }, null, 2));
  for (const { name, ids } of retired) {
    const result = await db
      .collection<{ readonly _id: string }>(name)
      .deleteMany({ _id: { $in: ids } });
    assert.equal(result.deletedCount, ids.length);
  }
  assert.ok(retired.some((value) => value.ids.length !== 0));
  const reopened = await openMongoTransactionOwner(options);
  const store = await reopened.openCollection({
    db: database,
    collection: 'nodes',
    logicalBase: '/',
    external: 'trusted',
  });
  const control = new AbortController();
  assert.ok(store.external);
  assert.ok(store.readExternal);
  const reporter = store.external(control.signal),
    iterator = reporter[Symbol.asyncIterator]();
  try {
    await reporter.ready;
    const pending = iterator.next();
    const physical = await db
      .collection('nodes')
      .findOne({ _path: '/a' }, { projection: { _id: 1 } });
    assert.ok(physical?._id instanceof ObjectId);
    await db.collection('nodes').deleteOne({ _id: physical._id });
    const notification = await pending;
    assert.equal(notification.done, false);
    assert.deepEqual(notification.value, ['/a']);
    const images = await store.readExternal(['/a'], scanBudget());
    assert.deepEqual(images.items, [{ path: '/a', id: node.$id, before: 'unknown', after: null }]);
    assert.equal(await db.collection('journal').countDocuments({ _position: position }), 0);
    assert.ok((await db.collection('journal.__locators').countDocuments()) >= 2);
  } finally {
    await iterator.return?.();
    control.abort();
    await store.close();
    await reopened.close();
    await pool.release();
  }
});
