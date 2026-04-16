// Treenity Mongo Tree — Layer 1
// Drop-in replacement for MemoryStore.

import { type NodeData, toStorageKeys, fromStorageKeys } from '@treenity/core';
import { OpError } from '@treenity/core/errors';
import { type Collection, type Db, MongoClient } from 'mongodb';
import { type Tree } from '@treenity/core/tree';
import { defaultPatch } from '@treenity/core/tree/patch';

const toStorage = (node: NodeData) => toStorageKeys(node);
const fromStorage = (doc: Record<string, unknown>) => fromStorageKeys(doc) as NodeData;

// Shared MongoClient pool — one client per URI, reused across mounts
const clientPool = new Map<string, { client: MongoClient; refCount: number; ready: Promise<MongoClient> }>();

function getSharedClient(uri: string): { client: MongoClient; ready: Promise<MongoClient>; release: () => Promise<void> } {
  let entry = clientPool.get(uri);
  if (!entry) {
    const client = new MongoClient(uri);
    const ready = client.connect();
    entry = { client, refCount: 0, ready };
    clientPool.set(uri, entry);
  }
  entry.refCount++;
  const release = async () => {
    const e = clientPool.get(uri);
    if (!e) return;
    e.refCount--;
    if (e.refCount <= 0) {
      clientPool.delete(uri);
      await e.client.close();
    }
  };
  return { client: entry.client, ready: entry.ready, release };
}

export async function createMongoTree(
  uri: string,
  dbName = 'treenity',
  collectionName = 'nodes',
): Promise<Tree & { close(): Promise<void> }> {
  const { client, ready, release } = getSharedClient(uri);
  await ready;
  const db: Db = client.db(dbName);
  const col: Collection = db.collection(collectionName);

  await col.createIndex({ _path: 1 }, { unique: true });

  function buildPattern(parent: string, depth: number): RegExp {
    const esc = escapeRegex(parent);
    const seg = '[^/]+';
    if (depth === 1) return parent === '/' ? /^\/[^/]+$/ : new RegExp(`^${esc}/${seg}$`);
    if (depth === Infinity) return parent === '/' ? /^\/.*$/ : new RegExp(`^${esc}/.+`);
    return parent === '/'
      ? new RegExp(`^(/${seg}){1,${depth}}$`)
      : new RegExp(`^${esc}(/${seg}){1,${depth}}$`);
  }

  async function paginatedFind(
    filter: Record<string, unknown>,
    opts?: { limit?: number; offset?: number },
  ) {
    const total = await col.countDocuments(filter);
    const cursor = col.find(filter).sort({ _path: 1 });
    if (opts?.offset) cursor.skip(opts.offset);
    if (opts?.limit) cursor.limit(opts.limit);
    const docs = await cursor.toArray();
    return { items: docs.map((doc) => fromStorage(doc as Record<string, unknown>)), total };
  }

  const tree: Tree & { close(): Promise<void> } = {
    async get(path, ctx) {
      const doc = await col.findOne({ _path: path });
      if (!doc) return undefined;
      return fromStorage(doc as Record<string, unknown>);
    },

    async getChildren(parent, opts, ctx) {
      const depth = opts?.depth ?? 1;
      const pathQuery = { _path: buildPattern(parent, depth) };
      const filter = opts?.query ? { $and: [pathQuery, opts.query] } : pathQuery;
      return paginatedFind(filter, opts);
    },

    async set(node, ctx) {
      const doc = toStorage(node);
      const prevRev = doc._rev as number | undefined;
      doc._rev = (prevRev ?? 0) + 1;

      if (prevRev === undefined) {
         try {
           await col.insertOne(doc);
         } catch(e: any) {
           if (e.code === 11000) throw new OpError('CONFLICT', `OptimisticConcurrencyError: node ${node.$path} already exists ($rev not set — did you mean to update?)`);
           throw e;
         }
      } else {
         const result = await col.replaceOne({ _path: doc._path, _rev: prevRev }, doc);
         if (result.matchedCount === 0) {
           throw new OpError('CONFLICT', `OptimisticConcurrencyError: node ${node.$path} modified by another transaction`);
         }
      }
      node.$rev = doc._rev as number;
    },

    async remove(path) {
      const result = await col.deleteOne({ _path: path });
      return result.deletedCount > 0;
    },

    // TODO: native Mongo $set — for now, fallback via get+apply+set
    async patch(path, ops, ctx) {
      return defaultPatch(tree.get, tree.set, path, ops, ctx);
    },

    async close() {
      await release();
    },
  };

  return tree;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
