import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { comparePaths } from '@treenx/core';
import { decodeChainNode } from '@treenx/core/kernel/chain-index';
import { scanBudget, storedNode } from '@treenx/core/kernel/testing';
import { createMongoStore, encode, type MongoStore } from '#store';

it('censuses identity and canonical rights without transferring authored payloads', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `census_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  await client.connect();
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo' });
  try {
    const node = storedNode('/a', { payload: 'x'.repeat(1024 * 1024),
      '#valid': { $type: 'component', payload: 'y'.repeat(1024 * 1024) },
      '#invalid': { $type: '' }, '#scalar': 'invalid', $owner: 42, $acl: 'invalid' });
    await client.db(db).collection('nodes').insertOne(encode(node));
    const result = await store.scan({ range: { census: '/' }, budget: { ...scanBudget(), bytes: 4096 } });
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], { $path: node.$path, $id: node.$id, $pos: node.$pos,
      chain: decodeChainNode(node) });
    assert.ok(result.cost !== undefined && result.cost.bytes < 4096);
  } finally {
    await store.close();
    await client.close();
  }
});

it('rejects cumulative census metadata above its host BSON allowance', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `census_budget_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  await client.connect();
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo', journalReadBsonBytes: 1000 });
  try {
    await client.db(db).collection('nodes').insertMany(Array.from({ length: 4 }, (_, index) =>
      encode(storedNode(`/item${index}`, { $owner: 'u:' + 'x'.repeat(300) }))));
    await assert.rejects(store.scan({ range: { census: '/' }, budget: scanBudget() }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
  } finally {
    await store.close();
    await client.close();
  }
});

it('censuses a valid metadata page larger than one BSON document', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `census_large_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  await client.connect();
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo',
    journalReadBsonBytes: 64 * 1024 * 1024 });
  try {
    const acl = Array.from({ length: 4000 }, (_, index) => ({ subject: { group: `u:${index}:${'x'.repeat(1000)}` }, grant: 1 }));
    const nodes = Array.from({ length: 5 }, (_, index) => storedNode(`/item${index}`, { $acl: acl }));
    await client.db(db).collection('nodes').insertMany(nodes.map(encode));
    const result = await store.scan({ range: { census: '/' },
      budget: { ...scanBudget(), bytes: 64 * 1024 * 1024 } });
    assert.equal(result.items.length, nodes.length);
    assert.ok(result.cost !== undefined && result.cost.bytes > 16 * 1024 * 1024);
    for (const item of result.items) {
      assert.equal(item.chain.acl.length, acl.length);
      assert.equal(item.chain.invalid, undefined);
    }
  } finally {
    await store.close();
    await client.close();
  }
});

it('preserves a census node whose valid metadata fills the BSON document limit', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `census_limit_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  await client.connect();
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo',
    journalReadBsonBytes: 64 * 1024 * 1024 });
  try {
    const id = new ObjectId();
    const seed = storedNode('/a', { $acl: [{ subject: { group: 'u:' }, grant: 1 }] });
    const overhead = BSON.serialize({ ...encode(seed), _id: id }).length;
    const group = 'u:' + 'x'.repeat(16 * 1024 * 1024 - overhead);
    const node = { ...seed, $acl: [{ subject: { group }, grant: 1 }] };
    const doc = { ...encode(node), _id: id };
    assert.equal(BSON.serialize(doc).length, 16 * 1024 * 1024);
    await client.db(db).collection('nodes').insertOne(doc);
    const result = await store.scan({ range: { census: '/' },
      budget: { ...scanBudget(), bytes: 64 * 1024 * 1024 } });
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].chain.acl, node.$acl);
    assert.equal(result.items[0].chain.invalid, undefined);
  } finally {
    await store.close();
    await client.close();
  }
});

it('retains later census rows while a larger row falls back at exact cumulative allowances', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `census_mixed_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  const nodes = [storedNode('/a', { $acl: [{ subject: { group: 'u:' + 'x'.repeat(3 * 1024 * 1024) }, grant: 1 }] }),
    storedNode('/b'), storedNode('/c'), storedNode('/d')];
  const physicalBytes = nodes.reduce((sum, node) => sum + BSON.serialize({ ...encode(node), components: {} }).length, 0);
  const expected = nodes.map(node => ({ $path: node.$path, $id: node.$id, $pos: node.$pos, chain: decodeChainNode(node) }));
  const logicalBytes = expected.reduce((sum, node) => sum + Buffer.byteLength(JSON.stringify(node)), 0);
  const options = { uri, db, collection: 'nodes', domain: 'mongo' };
  let short: MongoStore | undefined;
  await client.connect();
  const store = await createMongoStore({ ...options, journalReadBsonBytes: physicalBytes });
  try {
    await client.db(db).collection('nodes').insertMany(nodes.map(encode));
    const result = await store.scan({ range: { census: '/' }, budget: { ...scanBudget(), bytes: logicalBytes } });
    assert.deepEqual(result.items, expected);
    assert.equal(result.cost?.bytes, logicalBytes);
    await assert.rejects(store.scan({ range: { census: '/' }, budget: { ...scanBudget(), bytes: logicalBytes - 1 } }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    await store.close();
    short = await createMongoStore({ ...options, journalReadBsonBytes: physicalBytes - 1 });
    await assert.rejects(short.scan({ range: { census: '/' }, budget: { ...scanBudget(), bytes: logicalBytes } }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
  } finally {
    await short?.close();
    await store.close();
    await client.close();
  }
});

it('returns canonical Unicode census order across binary Mongo pages', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `census_unicode_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  await client.connect();
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo' });
  try {
    const paths = Array.from({ length: 103 }, (_, index) => `/item${index}`);
    paths.push('/\uE000', '/\u{10000}');
    await client.db(db).collection('nodes').insertMany(paths.map(path => encode(storedNode(path))));
    const result = await store.scan({ range: { census: '/' }, budget: scanBudget() });
    assert.deepEqual(result.items.map(node => node.$path), paths.sort(comparePaths));
  } finally {
    await store.close();
    await client.close();
  }
});
