import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { BSON, MongoClient } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import { encodeJournalEntry } from '@treenx/core/kernel/journal';
import { stableJson } from '@treenx/core/util/stable-json';
import type { FragmentJournalRoot, InlineJournalRoot, JournalCollections, JournalEntryIndex } from '#journal-records';
import type { JournalChunk } from '#journal-units';
import { scanJournalMetadata } from '#journal-scan';
import { upgradeJournal } from '#journal-upgrade';
import { createMongoStore } from '#store';

it('rejects oversized inline head metadata before transferring its canonical position', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const client = new MongoClient(uri, { monitorCommands: true });
  const replies: number[] = [];
  client.on('commandSucceeded', event => {
    if (event.commandName !== 'find') return;
    assert.ok(event.reply !== null && typeof event.reply === 'object');
    replies.push(BSON.serialize(event.reply).length);
  });
  await client.connect();
  try {
    const database = client.db(`head_${randomUUID().replaceAll('-', '')}`);
    const collections: JournalCollections = {
      owner: 'owner', roots: database.collection<InlineJournalRoot>('nodes.__journal'),
      headers: database.collection<FragmentJournalRoot>('nodes.__journal.__headers'),
      entries: database.collection<JournalEntryIndex>('nodes.__journal.__entries'),
      chunks: database.collection<JournalChunk>('nodes.__journal.__fragments'), physicalLimit: 1024,
    };
    const record = storeCommit(1, []).record;
    const pos = { ...record.pos, external: 'x'.repeat(3 * 1024 * 1024) };
    await collections.roots.insertOne({ ...record, pos, _id: stableJson(pos) });
    replies.length = 0;
    await assert.rejects(scanJournalMetadata(collections, {
      range: { journalHead: 'position' }, budget: { ...scanBudget(), bytes: 1024 },
    }, 'head'), (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.ok(replies.length > 0);
    assert.ok(replies.every(bytes => bytes < 4096));
    await assert.rejects(async () => {
      const opened = await createMongoStore({ uri, db: database.databaseName, collection: 'nodes', domain: 'mongo',
        journalReadBsonBytes: collections.physicalLimit });
      await opened.close();
    }, (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
  } finally {
    await client.close();
  }
});

it('bounds an already upgraded inline ancestor identity while reconstructing a compact legacy record', async context => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const client = new MongoClient(uri, { monitorCommands: true });
  const replies: number[] = [];
  client.on('commandSucceeded', event => {
    if (event.commandName !== 'find') return;
    assert.ok(event.reply !== null && typeof event.reply === 'object');
    replies.push(BSON.serialize(event.reply).length);
  });
  await client.connect();
  try {
    const database = client.db(`upgrade_ancestor_${randomUUID().replaceAll('-', '')}`);
    const collections: JournalCollections = {
      owner: 'owner', roots: database.collection<InlineJournalRoot>('journal'),
      headers: database.collection<FragmentJournalRoot>('journal'),
      entries: database.collection<JournalEntryIndex>('entries'),
      chunks: database.collection<JournalChunk>('chunks'), physicalLimit: 64 * 1024 * 1024,
    };
    const original = storedNode('/a', { payload: 'x'.repeat(2 * 1024 * 1024), count: 0 });
    const seed = storeCommit(1, [original]);
    const pos = { ...seed.pos, instance: 'x'.repeat(1024 * 1024) };
    const before = { ...original, $pos: pos };
    assert.ok(before.$id);
    const record = { ...seed.record, pos, entries: [{ id: before.$id, path: before.$path,
      change: { t: 'create' as const, after: before } }] };
    await collections.roots.insertOne({ ...record, _id: stableJson(pos) });
    await upgradeJournal(collections, client, async () => {}, 5000);
    assert.equal(await collections.roots.countDocuments({ _id: stableJson(pos), _position: { $exists: true } }), 1);
    const target = storeCommit(2, []);
    const after = { ...before, $pos: target.pos, count: 1 };
    const entry = encodeJournalEntry(before, after).entry;
    assert.equal(entry.change.t, 'update');
    if (entry.change.t !== 'update') throw new KernelError('INVALID', 'Expected a compact update');
    assert.equal(entry.change.after, undefined);
    await collections.roots.insertOne({ ...target.record, entries: [entry], _id: stableJson(target.pos) });
    replies.length = 0;
    const physicalLimit = 1536 * 1024;
    await assert.rejects(upgradeJournal({ ...collections, physicalLimit }, client, async () => {}, 5000),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.ok(replies.length > 0);
    context.diagnostic(JSON.stringify({ physicalLimit, encodedReplyBsonBytes: replies.reduce((bytes, reply) => bytes + reply, 0) }));
    assert.ok(replies.reduce((bytes, reply) => bytes + reply, 0) < physicalLimit + 4096);
  } finally {
    await client.close();
  }
});

it('bounds legacy upgrade selection before transferring an unrestricted position identity', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const client = new MongoClient(uri, { monitorCommands: true });
  const replies: number[] = [];
  client.on('commandSucceeded', event => {
    if (event.commandName !== 'find') return;
    assert.ok(event.reply !== null && typeof event.reply === 'object');
    replies.push(BSON.serialize(event.reply).length);
  });
  await client.connect();
  try {
    const database = client.db(`upgrade_head_${randomUUID().replaceAll('-', '')}`);
    const collections: JournalCollections = {
      owner: 'owner', roots: database.collection<InlineJournalRoot>('nodes.__journal'),
      headers: database.collection<FragmentJournalRoot>('nodes.__journal.__headers'),
      entries: database.collection<JournalEntryIndex>('nodes.__journal.__entries'),
      chunks: database.collection<JournalChunk>('nodes.__journal.__fragments'), physicalLimit: 1024,
    };
    const record = storeCommit(1, []).record;
    const pos = { ...record.pos, instance: 'x'.repeat(3 * 1024 * 1024) };
    await collections.roots.insertOne({ ...record, pos, _id: stableJson(pos) });
    replies.length = 0;
    await assert.rejects(upgradeJournal(collections, client, async () => {}, 5000),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.ok(replies.length > 0);
    assert.ok(replies.every(bytes => bytes < 4096));
  } finally {
    await client.close();
  }
});
