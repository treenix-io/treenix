import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { BSON, MongoClient } from 'mongodb'

import { planMongoUpgrade, backupMongoUpgrade, applyMongoUpgrade } from '#upgrade-kernel'
import { upgradeMongoCli } from '#upgrade-kernel-cli'

test('backs up exact BSON and atomically upgrades one real owning collection without rotating identity', { timeout: 10_000 }, async t => {
  const uri = process.env.KERNEL_UPGRADE_TEST_URI
  const fixtureArea = process.env.KERNEL_UPGRADE_TEST_AREA
  assert.ok(uri)
  assert.ok(fixtureArea)
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 })
  t.after(() => client.close())
  await client.connect()
  const admin = client.db('admin')
  const hello = await admin.command({ hello: 1 })
  assert.equal(hello.isWritablePrimary, true)
  assert.equal(typeof hello.setName, 'string')
  const database = `kernel_upgrade_${randomUUID().replaceAll('-', '')}`
  await writeFile(join(fixtureArea, `mongo-fixture-dataset-${database}.json`), JSON.stringify({ database, collection: 'nodes', fixture: 'explicit-replica-set' }), { flag: 'wx' })
  const collection = client.db(database).collection('nodes')
  await collection.insertMany([
    { _path: '.treenix-version', v: 1 },
    { _path: '/', _type: 'dir', _tid: 'unchanged-id', _rev: 9, _acl: [{ g: 'public', p: 9 }] },
  ])
  const position = { instance: 'mongo-upgrade-fixture', epoch: 0, seq: 0 }
  const plan = await planMongoUpgrade(collection, { validate: () => [] }, { nodes: 10, bytes: 4096, deadline: Date.now() + 1000 }, position)
  assert.equal(plan.conversion.findings.some(finding => finding.severity === 'error'), false)
  const area = await mkdtemp(join(fixtureArea, 'mongo-fixtures-'))
  const backup = join(area, 'backup')
  await backupMongoUpgrade(plan, backup)
  assert.deepEqual(await readFile(join(backup, '0.bson')), plan.rows[0])
  await assert.rejects(applyMongoUpgrade(collection, { ...plan, position: { ...position, seq: 1 } }, backup, Date.now() + 1000, client))
  await applyMongoUpgrade(collection, plan, backup, Date.now() + 1000, client)
  const accepted = await collection.findOne({ _path: '/' })
  assert.ok(accepted)
  assert.equal(accepted._tid, 'unchanged-id')
  assert.equal(accepted._type, 't.dir')
  assert.deepEqual(accepted._pos, position)
  assert.equal('_rev' in accepted, false)
  assert.deepEqual(accepted._acl, [{ subject: { group: 'public' }, grant: 1 }])
  const bytes = BSON.serialize(accepted)
  await applyMongoUpgrade(collection, plan, backup, Date.now() + 1000, client)
  const replayed = await collection.findOne({ _path: '/' })
  assert.ok(replayed)
  assert.deepEqual(BSON.serialize(replayed), bytes)
  assert.equal((await collection.findOne({ _path: '.treenix-version' }))?.v, 1)
  assert.equal((await collection.findOne({ _path: '.treenix-kernel-version' }))?.v, 2)
})

test('the owning Mongo CLI uses explicit deployment credentials, dry-run and backup before apply', { timeout: 10_000 }, async t => {
  const uri = process.env.KERNEL_UPGRADE_TEST_URI
  const fixtureArea = process.env.KERNEL_UPGRADE_TEST_AREA
  assert.ok(uri)
  assert.ok(fixtureArea)
  const previous = process.env.KERNEL_UPGRADE_FIXTURE_URI
  process.env.KERNEL_UPGRADE_FIXTURE_URI = uri
  t.after(() => {
    if (previous === undefined) delete process.env.KERNEL_UPGRADE_FIXTURE_URI
    else process.env.KERNEL_UPGRADE_FIXTURE_URI = previous
  })
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 })
  t.after(() => client.close())
  await client.connect()
  const database = `kernel_upgrade_cli_${randomUUID().replaceAll('-', '')}`
  await writeFile(join(fixtureArea, `mongo-fixture-dataset-${database}.json`), JSON.stringify({ database, collection: 'nodes', fixture: 'explicit-replica-set' }), { flag: 'wx' })
  const collection = client.db(database).collection('nodes')
  await collection.insertMany([{ _path: '.treenix-version', v: 1 }, { _path: '/', _type: 'dir', _tid: 'cli-id', _rev: 2 }])
  const area = await mkdtemp(join(fixtureArea, 'mongo-fixtures-'))
  const deployment = join(area, 'deployment.mjs')
  const core = new URL('../../../core/src/kernel/', import.meta.url)
  await writeFile(deployment, `import { createRegistry } from ${JSON.stringify(new URL('registry.ts', core).href)};
import { kernelManifest } from ${JSON.stringify(new URL('builtins.ts', core).href)};
const registry = createRegistry(); registry.publish(kernelManifest);
export const upgradeDeployment = { registry, mongoPosition: { instance: 'mongo-upgrade-cli', epoch: 0, seq: 0 } };
`)
  const args = ['--uri-env', 'KERNEL_UPGRADE_FIXTURE_URI', '--db', database, '--collection', 'nodes', '--deployment', deployment, '--plan', join(area, 'plan.json')]
  await upgradeMongoCli([...args, '--dry-run'])
  assert.equal((await collection.findOne({ _path: '/' }))?._rev, 2)
  await assert.rejects(upgradeMongoCli([...args, '--apply']))
  await upgradeMongoCli([...args, '--apply', '--backup', join(area, 'backup')])
  const accepted = await collection.findOne({ _path: '/' })
  assert.ok(accepted)
  assert.equal(accepted._type, 't.dir')
  assert.equal(accepted._pos.instance, 'mongo-upgrade-cli')
  await upgradeMongoCli([...args, '--apply', '--backup', join(area, 'backup')])
  assert.deepEqual(await collection.findOne({ _path: '/' }), accepted)
})
