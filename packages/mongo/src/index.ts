// Treenix Mongo Tree — Layer 1
// Drop-in replacement for MemoryStore.

import { type NodeData, toStorageKeys, fromStorageKeys } from '@treenx/core';
import { OpError } from '@treenx/core/errors';
import {
  type ChangeStream,
  type ChangeStreamDocument,
  type Collection,
  type Db,
  MongoClient,
} from 'mongodb';
import {
  type Tree,
  type TreeEvent,
  type TreeWatchOpts,
  type TreeWatchScope,
  subscriptionToAsyncIterable,
} from '@treenx/core/tree';
import { defaultPatch } from '@treenx/core/tree/patch';

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

export type MongoTreeOpts = {
  /** Enable `tree.watch` via Mongo change streams. OFF by default — change
   *  streams require a replica set (single-node mongod lacks them) and
   *  enabling pre-images via collMod needs admin permission. Turn on only
   *  to observe out-of-band writes. */
  watch?: boolean;
};

export async function createMongoTree(
  uri: string,
  dbName = 'treenix',
  collectionName = 'nodes',
  opts: MongoTreeOpts = {},
): Promise<Tree & { close(): Promise<void> }> {
  const { client, ready, release } = getSharedClient(uri);
  await ready;
  const db: Db = client.db(dbName);
  const col: Collection = db.collection(collectionName);

  await col.createIndex({ _path: 1 }, { unique: true });

  const watchEnabled = opts.watch === true;
  // Enable pre-images so DELETE events can carry _path. Best-effort —
  // fails if the caller lacks collMod or the collection already has it.
  if (watchEnabled) {
    try {
      await db.command({ collMod: collectionName, changeStreamPreAndPostImages: { enabled: true } });
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.warn(`[mongo] could not enable changeStreamPreAndPostImages on ${dbName}.${collectionName}: ${msg}. tree.watch delete events without pre-images will emit reconnect instead.`);
    }
  }

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

    /** Observe out-of-band Mongo writes via change streams. Opt-in via
     *  `{ watch: true }` — change streams require a replica set. */
    ...(watchEnabled ? {
      watch(scope: TreeWatchScope, opts?: TreeWatchOpts) {
        return mongoWatch(col, scope, opts);
      },
    } : {}),

    async close() {
      await release();
    },
  };

  return tree;
}

/** Direct-child check: matches /parent/x but not /parent (itself) or /parent/x/y. */
function isDirectChild(parent: string, candidate: string): boolean {
  const prefix = parent === '/' ? '/' : parent + '/';
  if (!candidate.startsWith(prefix)) return false;
  const rest = candidate.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

function matchesScope(event: TreeEvent, scope: TreeWatchScope): boolean {
  if (event.type === 'reconnect') return true;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'path') return event.path === scope.path;
  return isDirectChild(scope.path, event.path);
}

type MongoPathDoc = Record<string, unknown> & { _path?: string };

/** Map one Mongo change-stream document to a TreeEvent, or 'invalidate' when
 *  the cursor signals it must restart (drop / rename / invalidate / delete
 *  without preimage), or null to skip the event (unknown op, non-Treenix doc).
 *  Kept pure — change-stream typing isolated from the watch loop. */
export function mongoChangeToTreeEvent(change: ChangeStreamDocument): TreeEvent | 'invalidate' | null {
  switch (change.operationType) {
    case 'insert':
    case 'replace':
    case 'update': {
      const lookup = (change as { fullDocument?: MongoPathDoc | null }).fullDocument;
      if (!lookup || typeof lookup._path !== 'string') {
        // updateLookup race or non-Treenix doc — skip, no path to attach
        return null;
      }
      const node = fromStorage(lookup);
      const { $path, ...body } = node;
      return { type: 'set', path: $path, node: body };
    }
    case 'delete': {
      const pre = (change as { fullDocumentBeforeChange?: MongoPathDoc | null }).fullDocumentBeforeChange;
      if (!pre || typeof pre._path !== 'string') {
        // Pre-images disabled or unavailable — cannot reconstruct path,
        // ask caller to refetch the scope.
        return 'invalidate';
      }
      return { type: 'remove', path: pre._path };
    }
    case 'invalidate':
    case 'drop':
    case 'dropDatabase':
    case 'rename':
      return 'invalidate';
    default:
      return null;
  }
}

/** Subscribe to a Mongo collection change stream, mapped to TreeEvent.
 *  Exported so other Mongo-backed adapters can reuse the wiring (and so the
 *  unit suite can drive it with a mock Collection). For typical use, prefer
 *  `tree.watch(scope, opts)` returned by `createMongoTree()`. */
export function mongoWatch(
  col: Collection,
  scope: TreeWatchScope,
  opts?: TreeWatchOpts,
): AsyncIterable<TreeEvent> {
  return subscriptionToAsyncIterable<TreeEvent>(
    (push, endStream) => {
      const stream: ChangeStream = col.watch([], {
        fullDocument: 'updateLookup',
        fullDocumentBeforeChange: 'whenAvailable',
      });

      let closed = false;

      (async () => {
        try {
          for await (const change of stream) {
            if (closed) break;
            const out = mongoChangeToTreeEvent(change);
            if (out === null) continue;
            if (out === 'invalidate') {
              // Push reconnect first, then signal graceful end — consumer
              // sees the reconnect, then iterator returns done so any
              // `for await` loop terminates cleanly.
              push({ type: 'reconnect', preserved: false });
              endStream();
              return;
            }
            if (matchesScope(out, scope)) push(out);
          }
        } catch (err) {
          if (closed) return;
          console.error('[mongo-watch] change stream error:', err);
          push({ type: 'reconnect', preserved: false });
          endStream();
        }
      })();

      return () => {
        closed = true;
        stream.close().catch((err: unknown) => {
          console.error('[mongo-watch] failed to close change stream:', err);
        });
      };
    },
    { type: 'reconnect', preserved: false },
    opts,
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
