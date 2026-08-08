// mongo.collection mount — lives HERE, in the mongo package (not in core/src/mount).
// Core stays mongo-agnostic; the server loads this module as an optional backend
// registration at boot (factory.ts).

import { register } from '@treenx/core';
import { registerType } from '@treenx/core/comp';
import type { MountCtx } from '@treenx/core/mount';
import { loadSchemasFromDir } from '@treenx/core/schema/load';
import { createRepathTree, type Tree } from '@treenx/core/tree';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCollectionTree } from './collection';

// Self-contained registration: type + adapter + generated JSON schema, all on import.
loadSchemasFromDir(join(dirname(fileURLToPath(import.meta.url)), 'schemas'));

/** Read-only mount of a FOREIGN Mongo collection (arbitrary schema, not treenix-shaped).
 *  Docs surface as nodes with $path/$type synthesized in memory — the DB is never written
 *  (no _path index, no version marker — that's what separates it from t.mount.mongo). */
export class MountCollection {
  /** Explicit connection string. Prefer uriEnv — secrets stay out of the tree. */
  uri = '';
  /** Name of the env var holding the connection string (e.g. 'POLYMAX_MONGO_URI'). */
  uriEnv = '';
  db = '';
  collection = '';
  /** Doc field whose value becomes the node name ('slug' | 'wallet' | '_id'). */
  keyField = '';
  /** Constant $type stamped on every synthesized node. */
  type = '';
  /** Children order, single key only (e.g. { closeTs: -1 }); _id tiebreak appended. */
  sort: Record<string, 1 | -1> = {};
  /** Server-side pre-filter merged into every read. */
  baseQuery?: Record<string, unknown>;
}
registerType('mongo.collection', MountCollection);

register(MountCollection, 'mount', async (mount, ctx: MountCtx): Promise<Tree> => {
  const uri = mount.uri || (mount.uriEnv && process.env[mount.uriEnv]) || process.env.MONGO_URI;
  if (!uri) throw new Error(`mongo.collection at ${ctx.path}: no uri (set uri, uriEnv, or MONGO_URI)`);
  for (const field of ['db', 'collection', 'keyField', 'type'] as const) {
    if (!mount[field]) throw new Error(`mongo.collection at ${ctx.path}: "${field}" is required`);
  }

  const tree = await openCollectionTree(uri, mount.db, mount.collection, mount);
  return createRepathTree(tree, ctx.path, '/');
});
