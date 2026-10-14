import { createHash } from 'node:crypto';
import { KernelError } from '@treenx/core/errors';
import type { Db } from 'mongodb';

const catalog = '__treenx_native_namespaces';
export interface NamespaceClaim {
  readonly collection: string;
  readonly role:
    | 'data'
    | 'journal'
    | 'control'
    | 'headers'
    | 'fragments'
    | 'entries'
    | 'locators'
    | 'locator-fragments'
    | 'transactions'
    | 'backfill'
    | 'blob-holds'
    | 'blob-coverage'
    | 'blob-archives'
    | 'blob-archive-owners';
  readonly owner: string;
  readonly coordinator: string;
  readonly logicalBase?: string;
}
const identity = (collection: string) => createHash('sha256').update(collection).digest('hex');

/** Physical collection authority survives handle retirement and uses binary fixed-size identity keys. */
export async function readNamespace(db: Db, collection: string): Promise<NamespaceClaim | null> {
  if (collection === catalog)
    throw new KernelError('INVALID', 'Mongo namespace catalog cannot be a Store collection');
  const found = await db
    .collection<NamespaceClaim & { readonly _id: string }>(catalog)
    .findOne({ _id: identity(collection) }, { collation: { locale: 'simple' } });
  if (found === null) return null;
  const { _id, ...claim } = found;
  if (claim.collection !== collection)
    throw new KernelError('INVALID', 'Mongo namespace identity differs from its collection');
  return claim;
}

/** Claim before index creation so an incompatible native collection is never mutated. */
export async function claimNamespace(db: Db, claim: NamespaceClaim): Promise<void> {
  if (claim.collection === catalog)
    throw new KernelError('INVALID', 'Mongo namespace catalog cannot be a Store collection');
  const claims = db.collection<NamespaceClaim & { readonly _id: string }>(catalog);
  await claims.updateOne(
    { _id: identity(claim.collection) },
    { $setOnInsert: claim },
    { upsert: true, collation: { locale: 'simple' } },
  );
  const current = await readNamespace(db, claim.collection);
  if (
    current === null ||
    current.owner !== claim.owner ||
    current.role !== claim.role ||
    current.coordinator !== claim.coordinator
  )
    throw new KernelError('CONFLICT', 'Mongo collection belongs to a different native namespace');
}
