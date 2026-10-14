import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { Binary, BSON, MongoClient, type Document } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { scanBudget } from '@treenx/core/kernel/testing';
import {
  readJournalUnit,
  writeJournalUnit,
  type JournalChunk,
  type JournalReadLedger,
  type JournalUnit,
} from '#journal-units';

interface FindReply {
  readonly cursor: { readonly firstBatch: readonly Document[] };
}

it('reconstructs oversized BSON units losslessly with cumulative allowances and loud corruption', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const client = new MongoClient(uri, { monitorCommands: true });
  const reads: string[] = [];
  client.on('commandStarted', (event) => {
    if (['find', 'getMore', 'killCursors'].includes(event.commandName))
      reads.push(event.commandName);
  });
  await client.connect();
  const chunks = client
    .db(`units_${randomUUID().replaceAll('-', '')}`)
    .collection<JournalChunk>('chunks');
  const session = client.startSession();
  try {
    const value = {
      payload: 'a'.repeat(19 * 1024 * 1024),
      date: new Date(123456),
      expression: /a+b/gi,
    };
    const identity = { owner: 'owner', position: 'position', unit: 'large' };
    let manifest: JournalUnit | undefined;
    await session.withTransaction(async () => {
      manifest = await writeJournalUnit(chunks, identity, value, session);
    });
    assert.ok(manifest);
    const ledger = (): JournalReadLedger => ({
      budget: { ...scanBudget(), bytes: 32 * 1024 * 1024, deadline: Date.now() + 5000 },
      physicalLimit: 32 * 1024 * 1024,
      physicalBytes: 0,
      logicalBytes: 0,
    });
    const allowance = ledger();
    reads.length = 0;
    assert.deepEqual(await readJournalUnit(chunks, manifest, identity, allowance), value);
    assert.equal(reads.length, manifest.chunks);
    assert.ok(reads.every((command) => command === 'find'));
    assert.equal(allowance.physicalBytes, manifest.bsonBytes);
    assert.equal(allowance.logicalBytes, manifest.logicalBytes);
    const count = reads.length;
    await assert.rejects(
      readJournalUnit(chunks, manifest, identity, allowance),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET',
    );
    assert.equal(reads.length, count);
    await assert.rejects(
      readJournalUnit(chunks, { ...manifest, chunks: manifest.chunks + 1 }, identity, ledger()),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
    assert.equal(reads.length, count);
    await assert.rejects(
      readJournalUnit(chunks, manifest, { ...identity, owner: 'another' }, ledger()),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
    assert.equal(reads.length, count);
    await chunks.updateOne(
      { _id: `${manifest.key}:0` },
      { $set: { payload: new Binary(Buffer.alloc(1024 * 1024 + 1)) } },
    );
    await assert.rejects(
      readJournalUnit(chunks, manifest, identity, ledger()),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
    const malformed = Buffer.from(BSON.serialize(value, { ignoreUndefined: false }));
    malformed.writeInt32LE(malformed.length - 1, 0);
    await chunks.updateOne(
      { _id: `${manifest.key}:0` },
      { $set: { payload: new Binary(malformed.subarray(0, 1024 * 1024)) } },
    );
    await assert.rejects(
      readJournalUnit(
        chunks,
        { ...manifest, hash: createHash('sha256').update(malformed).digest('hex') },
        identity,
        ledger(),
      ),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
    malformed.writeInt32LE(malformed.length, 0);
    malformed[4] = 0x55;
    await chunks.updateOne(
      { _id: `${manifest.key}:0` },
      { $set: { payload: new Binary(malformed.subarray(0, 1024 * 1024)) } },
    );
    await assert.rejects(
      readJournalUnit(
        chunks,
        { ...manifest, hash: createHash('sha256').update(malformed).digest('hex') },
        identity,
        ledger(),
      ),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
  } finally {
    await session.endSession();
    await client.close();
  }
});

it('fetches only a tiny declared chunk when a persisted row has an unrelated large field', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const client = new MongoClient(uri, { monitorCommands: true });
  let projection: unknown;
  let responseBytes = 0;
  client.on('commandStarted', (event) => {
    if (event.commandName === 'find') projection = event.command.projection;
  });
  client.on('commandSucceeded', (event) => {
    if (event.commandName === 'find') {
      const reply = event.reply as FindReply;
      responseBytes = BSON.serialize(reply.cursor.firstBatch[0]).length;
    }
  });
  await client.connect();
  const chunks = client
    .db(`projection_${randomUUID().replaceAll('-', '')}`)
    .collection<JournalChunk>('chunks');
  const session = client.startSession();
  try {
    const identity = { owner: 'owner', position: 'position', unit: 'tiny' };
    let manifest: JournalUnit | undefined;
    await session.withTransaction(async () => {
      manifest = await writeJournalUnit(chunks, identity, { valid: true }, session);
    });
    assert.ok(manifest);
    await chunks.updateOne(
      { _id: `${manifest.key}:0` },
      { $set: { unrelated: 'x'.repeat(7 * 1024 * 1024) } },
    );
    const value = await readJournalUnit(chunks, manifest, identity, {
      budget: { ...scanBudget(), bytes: manifest.logicalBytes },
      physicalLimit: manifest.bsonBytes,
      physicalBytes: 0,
      logicalBytes: 0,
    });
    assert.deepEqual(value, { valid: true });
    assert.deepEqual(projection, { _id: 0, payload: 1 });
    assert.ok(responseBytes <= manifest.bsonBytes + 64);
  } finally {
    await session.endSession();
    await client.close();
  }
});
