import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { MongoClient } from 'mongodb'

import { isUpgradePlan, upgradeObject } from '@treenx/core/tools/upgrade-kernel-plan'
import { loadUpgradeDeployment } from '@treenx/core/tools/upgrade-kernel'
import { isPosition } from '@treenx/core/kernel/input-boundary'
import { applyMongoUpgrade, backupMongoUpgrade, planMongoUpgrade, type MongoUpgradePlan } from '#upgrade-kernel'

/** Decode the explicit operator artifact before its database names or converted rows are used. */
function savedMongoPlan(value: unknown): MongoUpgradePlan {
  const input = upgradeObject(value)
  if (typeof input.database !== 'string' || typeof input.collection !== 'string' || !Array.isArray(input.rows)
    || !isUpgradePlan(input.conversion) || !isPosition(input.position)) throw new Error('INVALID_UPGRADE_PLAN')
  const rows: Buffer[] = []
  let bytes = 0
  for (const value of input.rows) {
    if (typeof value !== 'string' || value.length > Math.ceil((64 * 1024 * 1024 - bytes) / 3) * 4) throw new Error('BUDGET')
    const row = Buffer.from(value, 'base64')
    if (row.toString('base64') !== value) throw new Error('INVALID_BACKUP_ROW')
    bytes += row.length
    rows.push(row)
  }
  return { database: input.database, collection: input.collection, conversion: input.conversion, position: input.position, rows }
}

/** Own the explicit Mongo connection; credentials enter only through the named deployment environment variable. */
export async function upgradeMongoCli(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: {
    'uri-env': { type: 'string' }, db: { type: 'string' }, collection: { type: 'string' }, deployment: { type: 'string' },
    plan: { type: 'string' }, backup: { type: 'string' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, resume: { type: 'boolean' },
  } })
  if (values['uri-env'] === undefined || values.db === undefined || values.collection === undefined
    || values.deployment === undefined || values.plan === undefined || Boolean(values.apply) === Boolean(values['dry-run']))
    throw new Error('REQUIRES_COLLECTION_DEPLOYMENT_PLAN_AND_ONE_MODE')
  if (values.resume && !values.apply) throw new Error('RESUME_REQUIRES_APPLY')
  const uri = process.env[values['uri-env']]
  if (uri === undefined || uri.length === 0) throw new Error('EXPLICIT_MONGO_CREDENTIAL_REQUIRED')
  const options = await loadUpgradeDeployment(values.deployment)
  if (options.mongoPosition === undefined) throw new Error('NATIVE_POSITION_REQUIRED')
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 })
  try {
    await client.connect()
    const collection = client.db(values.db).collection(values.collection)
    const completed = await collection.findOne({ _path: '.treenix-kernel-version' }, { timeoutMS: 1000 })
    if (completed !== null) {
      if (completed.v !== 2) throw new Error('INVALID_KERNEL_DATA_VERSION')
      console.log(JSON.stringify({ completed: true, documents: 0, findings: [] }))
      return
    }
    let plan: MongoUpgradePlan
    if (values['dry-run']) {
      plan = await planMongoUpgrade(collection, options, { nodes: 10_000, bytes: 64 * 1024 * 1024, deadline: Date.now() + 5000 }, options.mongoPosition)
      const handle = await open(resolve(values.plan), 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ ...plan, rows: plan.rows.map(row => row.toString('base64')) }))
        await handle.sync()
      } finally { await handle.close() }
    } else {
      if (values.backup === undefined) throw new Error('EXPLICIT_BACKUP_REQUIRED')
      plan = savedMongoPlan(JSON.parse(await readFile(resolve(values.plan), 'utf8')))
      if (plan.database !== values.db || plan.collection !== values.collection) throw new Error('WRONG_COLLECTION')
      for (const document of plan.conversion.documents)
        if (options.validate(document.body, document.path).length !== 0) throw new Error('CURRENT_SCHEMA_CHANGED')
      if (!values.resume) await backupMongoUpgrade(plan, values.backup)
      await applyMongoUpgrade(collection, plan, values.backup, Date.now() + 5000, client)
    }
    console.log(JSON.stringify({ completed: values.apply === true, documents: plan.conversion.documents.length, findings: plan.conversion.findings }))
  } finally { await client.close() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await upgradeMongoCli(process.argv.slice(2))
