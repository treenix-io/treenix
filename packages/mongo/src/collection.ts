// Read-only Tree over an EXTERNAL Mongo collection (foreign schema — not treenix-shaped).
// createMongoTree is unusable for foreign data: it requires `_path` docs + a unique index
// and stamps a version marker into the collection. This adapter NEVER writes to the DB —
// no indexes, no markers. $path/$type are synthesized in memory on read: node name comes
// from `keyField`, $type is the constant `type` from config.

import { type NodeData } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { type Page, type TreeSource } from '@treenx/core/tree';
import { type Collection, type Document, ObjectId } from 'mongodb';
import { getSharedClient } from './index';

export type CollectionTreeConfig = {
  /** Doc field whose value becomes the node name (e.g. 'slug' | 'wallet' | '_id'). */
  keyField: string;
  /** Constant $type stamped on every synthesized node. */
  type: string;
  /** Children order, single key only (e.g. { closeTs: -1 }); _id tiebreak appended. */
  sort?: Record<string, 1 | -1>;
  /** Server-side pre-filter merged into every read. */
  baseQuery?: Record<string, unknown>;
};

// Mongo's own code-eval blocklist: the query goes to a live Mongo server where $where is code-eval.
// Narrower than core's kernel/expr.ts guard — it neither refuses $regex nor checks the expression size, its
// operands or its work.
const FORBIDDEN_QUERY_KEYS = new Set(['$where', '$function', '$accumulator', '$expr']);
const SYSTEM_FIELD_KEYS = new Set(['$path', '$id', '$refId', '$rev', '$acl', '$owner', '$v']);

function assertSafeQuery(q: unknown): void {
  if (Array.isArray(q)) {
    for (const item of q) assertSafeQuery(item);
    return;
  }
  if (!q || typeof q !== 'object' || q.constructor !== Object) return;
  for (const [k, v] of Object.entries(q)) {
    if (FORBIDDEN_QUERY_KEYS.has(k)) throw new KernelError('INVALID', `Forbidden query operator: ${k}`);
    if (SYSTEM_FIELD_KEYS.has(k)) throw new KernelError('INVALID', `System field ${k} is not queryable on a foreign collection`);
    assertSafeQuery(v);
  }
}

/** Split off a top-level `$type` condition: synthesized nodes all share one $type, so it
 *  either matches trivially (drop it) or can never match (whole query is empty). */
function resolveTypeCond(query: Record<string, unknown>, type: string): { rest: Record<string, unknown>; empty: boolean } {
  if (!('$type' in query)) return { rest: query, empty: false };
  const { $type, ...rest } = query;
  return { rest, empty: $type !== type };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function encodeCursor(sortValue: unknown, idHex: string): string {
  return b64(JSON.stringify([sortValue, idHex]));
}

function decodeCursor(token: string): { sortValue: unknown; idHex: string } {
  try {
    const [sortValue, idHex] = JSON.parse(unb64(token)) as [unknown, string];
    if (typeof idHex !== 'string') throw new Error('bad cursor');
    return { sortValue, idHex };
  } catch {
    throw new KernelError('INVALID', 'collection mount: malformed pagination cursor');
  }
}

/** Connect via the package-wide shared client pool and wrap one collection. */
export async function openCollectionTree(
  uri: string,
  dbName: string,
  collectionName: string,
  config: CollectionTreeConfig,
): Promise<TreeSource & { close(): Promise<void> }> {
  const { client, ready, release } = getSharedClient(uri);
  await ready;
  const col = client.db(dbName).collection(collectionName);
  return { ...createCollectionTree(col, config), close: release };
}

/** Read-only TreeSource over one foreign collection. Local paths: '/' = the dir,
 *  '/<key>' = one doc. Flat — foreign docs have no hierarchy. */
export function createCollectionTree(col: Collection, config: CollectionTreeConfig): TreeSource {
  const { keyField, type } = config;

  const sortEntries = Object.entries(config.sort ?? {});
  if (sortEntries.length > 1) throw new KernelError('INVALID', 'collection mount: single-key sort only');
  const [sortField, sortDir] = sortEntries[0] ?? ['_id', -1 as const];
  const mongoSort: Record<string, 1 | -1> = sortField === '_id' ? { _id: sortDir } : { [sortField]: sortDir, _id: sortDir };
  const strictOp = sortDir === 1 ? '$gt' : '$lt';

  function toNode(doc: Document): NodeData {
    const { _id, ...fields } = doc;
    const key = keyField === '_id' ? String(_id) : doc[keyField];
    if (typeof key !== 'string' || key === '' || key.includes('/')) {
      throw new KernelError('INVALID', `collection mount: doc ${String(_id)} has no usable key in field "${keyField}"`);
    }
    return { ...fields, $path: `/${key}`, $type: type };
  }

  function entryCursor(doc: Document): string {
    const idHex = String(doc._id);
    return encodeCursor(sortField === '_id' ? idHex : doc[sortField] ?? null, idHex);
  }

  /** Resume strictly after a cursor position in the (sortField, _id) total order. */
  function afterFilter(token: string): Record<string, unknown> {
    const { sortValue, idHex } = decodeCursor(token);
    let oid: ObjectId;
    try {
      oid = new ObjectId(idHex);
    } catch {
      throw new KernelError('INVALID', 'collection mount: malformed pagination cursor');
    }
    if (sortField === '_id') return { _id: { [strictOp]: oid } };
    return {
      $or: [
        { [sortField]: { [strictOp]: sortValue } },
        { [sortField]: sortValue, _id: { [strictOp]: oid } },
      ],
    };
  }

  function buildFilter(query?: Record<string, unknown>, after?: string): Record<string, unknown> | null {
    const parts: Record<string, unknown>[] = [];
    if (config.baseQuery) parts.push(config.baseQuery);
    if (query) {
      assertSafeQuery(query);
      const { rest, empty } = resolveTypeCond(query, type);
      if (empty) return null;
      if (Object.keys(rest).length) parts.push(rest);
    }
    if (after !== undefined) parts.push(afterFilter(after));
    if (parts.length === 0) return {};
    return parts.length === 1 ? parts[0] : { $and: parts };
  }

  function keyFilter(key: string): Record<string, unknown> | null {
    if (keyField !== '_id') return { [keyField]: key };
    try {
      return { _id: new ObjectId(key) };
    } catch {
      return null; // not a valid ObjectId — path simply doesn't exist
    }
  }

  const readOnly = async (): Promise<never> => {
    throw new KernelError('FORBIDDEN', 'collection mount is read-only: the external DB is never written');
  };

  const tree: TreeSource = {
    async get(path) {
      if (path === '/') return { $path: '/', $type: 'dir' };
      const key = path.slice(1);
      if (key === '' || key.includes('/')) return undefined; // flat collection — no deeper paths
      const filter = keyFilter(key);
      if (!filter) return undefined;
      const doc = await col.findOne(config.baseQuery ? { $and: [config.baseQuery, filter] } : filter);
      return doc ? toNode(doc) : undefined;
    },

    async getChildren(parent, opts): Promise<Page<NodeData>> {
      if (parent !== '/') return { items: [], total: 0 };
      const filter = buildFilter(opts?.query, opts?.cursor);
      if (filter === null) return { items: [], total: 0 };

      const limit = opts?.limit;
      const cursor = col.find(filter).sort(mongoSort);
      if (limit) cursor.limit(limit + 1); // +1 = detect next page without countDocuments
      const docs = await cursor.toArray();

      const hasMore = limit !== undefined && docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const page: Page<NodeData> = { items: pageDocs.map(toNode), total: pageDocs.length };
      if (hasMore) page.nextCursor = entryCursor(pageDocs[pageDocs.length - 1]);
      return page;
    },

    async *scanChildren(parent, opts) {
      if (parent !== '/') return;
      const filter = buildFilter(undefined, opts?.after);
      if (filter === null) return;
      if (opts?.signal?.aborted) throw opts.signal.reason;

      const cursor = col.find(filter).sort(mongoSort);
      // limitHint is a batching hint, NOT a cap — the read runtime filters after us
      // (callerWhere/ACL) and keeps pulling until IT has enough. Truncating here made
      // every filtered query return empty past the first batch.
      if (opts?.limitHint) cursor.batchSize(Math.min(opts.limitHint, 1000));

      const onAbort = () => { cursor.close().catch(() => {}); };
      opts?.signal?.addEventListener('abort', onAbort);
      try {
        for await (const doc of cursor) {
          yield { node: toNode(doc), cursor: entryCursor(doc) };
        }
      } finally {
        opts?.signal?.removeEventListener('abort', onAbort);
      }
    },

    set: readOnly,
    remove: readOnly,
    patch: readOnly,
  };

  return tree;
}
