import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BSON, type Collection, type Document, type MongoClient } from 'mongodb';

import { fromStorageKeys, toStorageKeys } from '@treenx/core/kernel/store/keys';
import type { Position } from '@treenx/core/kernel/types';
import {
  planKernelUpgrade,
  type UpgradeDocument,
  type UpgradeOptions,
  type UpgradePlan,
} from '@treenx/core/tools/upgrade-kernel-plan';

export interface MongoUpgradePlan {
  readonly database: string;
  readonly collection: string;
  readonly rows: readonly Buffer[];
  readonly conversion: UpgradePlan;
  readonly position: Position;
}

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** Bind the backup to the exact adopted snapshot and conversion decision. */
function backupMetadata(plan: MongoUpgradePlan): string {
  return JSON.stringify({
    database: plan.database,
    collection: plan.collection,
    conversion: plan.conversion,
    position: plan.position,
    rows: plan.rows.map(digest),
  });
}

/** Read one explicit owning collection with a finite cumulative BSON allowance. */
export async function planMongoUpgrade(
  collection: Collection,
  options: UpgradeOptions,
  bounds: { readonly nodes: number; readonly bytes: number; readonly deadline: number },
  position: Position,
): Promise<MongoUpgradePlan> {
  if (bounds.nodes < 1 || Date.now() > bounds.deadline) throw new Error('BUDGET');
  const marker = await collection.findOne(
    { _path: '.treenix-version' },
    { timeoutMS: Math.max(1, bounds.deadline - Date.now()) },
  );
  if (marker?.v !== 1) throw new Error('REQUIRES_DATA_VERSION_1');
  const rows: Buffer[] = [];
  const documents: UpgradeDocument[] = [];
  let bytes = BSON.serialize(marker).length;
  if (bytes > bounds.bytes) throw new Error('BUDGET');
  const cursor = collection.find(
    {},
    { batchSize: 1, timeoutMS: Math.max(1, bounds.deadline - Date.now()) },
  );
  try {
    for await (const row of cursor) {
      if (Date.now() > bounds.deadline || rows.length + 1 >= bounds.nodes)
        throw new Error('BUDGET');
      const raw = Buffer.from(BSON.serialize(row));
      bytes += raw.length;
      if (bytes > bounds.bytes) throw new Error('BUDGET');
      rows.push(raw);
      if (typeof row._path === 'string' && row._path.startsWith('/')) {
        documents.push({ path: row._path, body: fromStorageKeys(row) });
      } else if (row._path !== '.treenix-version') throw new Error('UNKNOWN_COLLECTION_METADATA');
    }
  } finally {
    await cursor.close();
  }
  return {
    database: collection.dbName,
    collection: collection.collectionName,
    rows,
    position: { ...position },
    conversion: planKernelUpgrade(documents, options),
  };
}

/** Preserve BSON identities and every original row before any collection mutation. */
export async function backupMongoUpgrade(plan: MongoUpgradePlan, directory: string): Promise<void> {
  await mkdir(directory, { recursive: false });
  for (let index = 0; index < plan.rows.length; index++) {
    const handle = await open(join(directory, `${index}.bson`), 'wx', 0o600);
    try {
      await handle.writeFile(plan.rows[index]);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const handle = await open(join(directory, 'plan.json'), 'wx', 0o600);
  try {
    await handle.writeFile(backupMetadata(plan));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Verify backed-up preimages and publish all converted rows and completion in one owning transaction. */
export async function applyMongoUpgrade(
  collection: Collection,
  plan: MongoUpgradePlan,
  backup: string,
  deadline: number,
  client: MongoClient,
): Promise<void> {
  if (collection.dbName !== plan.database || collection.collectionName !== plan.collection)
    throw new Error('WRONG_COLLECTION');
  if (plan.conversion.findings.some((finding) => finding.severity === 'error'))
    throw new Error('UNRESOLVED_UPGRADE');
  if ((await readFile(join(backup, 'plan.json'), 'utf8')) !== backupMetadata(plan))
    throw new Error('BACKUP_CHANGED');
  for (let index = 0; index < plan.rows.length; index++) {
    if (digest(await readFile(join(backup, `${index}.bson`))) !== digest(plan.rows[index]))
      throw new Error('BACKUP_CHANGED');
  }
  const session = client.startSession();
  try {
    await session.withTransaction(
      async () => {
        const replacements = new Map(
          plan.conversion.documents.map((document) => [document.path, document.body]),
        );
        const retired = new Set(plan.conversion.retired);
        const completion = await collection.findOne(
          { _path: '.treenix-kernel-version' },
          { session },
        );
        if (completion?.v === 2 && completion.inputHash === plan.conversion.inputHash) return;
        for (const raw of plan.rows) {
          if (Date.now() > deadline) throw new Error('BUDGET');
          const before: Document = BSON.deserialize(raw);
          const current = await collection.findOne({ _id: before._id }, { session });
          if (current === null || digest(Buffer.from(BSON.serialize(current))) !== digest(raw))
            throw new Error('SOURCE_CHANGED');
          if (typeof before._path !== 'string' || !before._path.startsWith('/')) continue;
          if (retired.has(before._path)) {
            await collection.deleteOne({ _id: before._id }, { session });
            continue;
          }
          const body = replacements.get(before._path);
          if (body === undefined) throw new Error('INCOMPLETE_PLAN');
          await collection.replaceOne(
            { _id: before._id },
            { ...toStorageKeys(body), _path: before._path, _pos: plan.position },
            { session },
          );
          replacements.delete(before._path);
        }
        for (const [path, body] of replacements) {
          if ((await collection.findOne({ _path: path }, { session })) !== null)
            throw new Error('NEW_TARGET_OCCUPIED');
          await collection.insertOne(
            { ...toStorageKeys(body), _path: path, _pos: plan.position },
            { session },
          );
        }
        await collection.insertOne(
          { _path: '.treenix-kernel-version', v: 2, inputHash: plan.conversion.inputHash },
          { session },
        );
      },
      { timeoutMS: Math.max(1, deadline - Date.now()) },
    );
  } finally {
    await session.endSession();
  }
}
