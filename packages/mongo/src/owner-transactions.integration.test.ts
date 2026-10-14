import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { Binary, Long, type CommandStartedEvent } from 'mongodb';
import { scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import { getSharedClient } from '#index';
import { openMongoTransactionOwner, type MongoTransactionOwner } from '#owner';
import { transactionKey, wireTransaction, type OwnedTransaction } from '#owner-transactions';

it('recognizes actual owned transaction tuples before settlement and after reopening', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const database = `owned_stream_${randomUUID().replaceAll('-', '')}`;
  const options = {
    uri,
    domain: database,
    instance: 'test',
    journalDb: database,
    journalCollection: 'journal',
  };
  const pool = getSharedClient(uri, true);
  const observed: OwnedTransaction[] = [];
  let currentOwner: MongoTransactionOwner | undefined;
  let pending: Promise<boolean> | undefined;
  let settled = false;
  /** Observe the driver's real transaction commands while the owner is still settling. */
  function observe(event: CommandStartedEvent): void {
    if (event.command.autocommit !== false) return;
    const transaction = wireTransaction(event.command.lsid, event.command.txnNumber);
    observed.push(transaction);
    const captured = currentOwner;
    if (captured !== undefined && pending === undefined)
      pending = Promise.resolve().then(() => {
        assert.equal(settled, false);
        return captured.ownsTransaction(transaction, scanBudget());
      });
  }
  pool.client.on('commandStarted', observe);
  const owner = await openMongoTransactionOwner(options);
  currentOwner = owner;
  const store = await owner.openCollection({ db: database, collection: 'nodes', logicalBase: '/' });
  try {
    const commit = storeCommit(1, [storedNode('/a')], [], owner.resources.writerEpoch);
    await owner.commit(commit, [{ store, writes: commit.writes }]);
    settled = true;
    assert.equal(await pending, true);
    assert.ok(observed.length > 0);
    const transaction = observed[0];
    assert.ok(observed.every((value) => transactionKey(value) === transactionKey(transaction)));
    assert.equal(await owner.ownsTransaction(transaction, scanBudget()), true);
    assert.equal(
      await owner.ownsTransaction(
        { ...transaction, number: transaction.number.add(Long.ONE) },
        scanBudget(),
      ),
      false,
    );
    assert.equal(
      await owner.ownsTransaction(
        { ...transaction, session: new Binary(randomBytes(16), Binary.SUBTYPE_UUID) },
        scanBudget(),
      ),
      false,
    );
    await store.close();
    await owner.close();
    const reopened = await openMongoTransactionOwner(options);
    try {
      assert.equal(await reopened.ownsTransaction(transaction, scanBudget()), true);
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
    await owner.close();
    pool.client.off('commandStarted', observe);
    await pool.release();
  }
});
