// Foreign collection configuration data; Polymax owns its native bounded source reads.

import { registerType } from '@treenx/core/comp';
import { loadSchemasFromDir } from '@treenx/core/schema/load';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Register the configuration class and its generated schema.
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
