import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it } from 'node:test'
import { MongoClient } from 'mongodb'
import { KernelError } from '@treenx/core/errors'
import { position, scanBudget, storedNode } from '@treenx/core/kernel/testing'
import { transferImageDigest } from '@treenx/core/kernel/transfer-image'
import type { StoreCommit } from '@treenx/core/kernel/types'
import { createMongoStore } from '#store'

it('preserves unstamped source edits and rolls back all transfer deletions and markers', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI
  assert.ok(uri)
  const db = `transfer_cleanup_${randomUUID().replaceAll('-', '')}`
  const store = await createMongoStore({ uri, db, collection: 'nodes', domain: db })
  const client = new MongoClient(uri)
  try {
    await client.connect()
    const nodes = [storedNode('/first'), storedNode('/second')]
    await store.commit({ pos: position(2), writerEpoch: 1,
      writes: nodes.map(node => ({ path: node.$path, node })),
      record: { pos: position(2), kind: 'transfer', executor: 'kernel', caller: 'kernel', entries: [] } })
    const cleanup: StoreCommit = { pos: position(3), writerEpoch: 1,
      maintenanceLimits: { changeSet: 2, budget: scanBudget() },
      writes: nodes.map(node => ({ path: node.$path, node: null })),
      transferBefore: nodes.map(node => ({ path: node.$path, sourceId: node.$id, id: node.$id, pos: node.$pos,
        digest: transferImageDigest(node, scanBudget(), { exprWork: 0 }),
        copiedDigest: transferImageDigest(node, scanBudget(), { exprWork: 0 }) })),
      record: { pos: position(3), kind: 'transfer', executor: 'kernel', caller: 'kernel', entries: [] } }
    const physical = client.db(db).collection('nodes')
    const markers = client.db(db).collection('nodes.__journal.__transactions')
    const count = await markers.countDocuments()
    await physical.updateOne({ _path: '/second' }, { $set: { value: 'external edit' } })
    await assert.rejects(store.commit(cleanup), error => error instanceof KernelError && error.code === 'CONFLICT')
    assert.equal(await physical.countDocuments(), 2)
    assert.equal((await physical.findOne({ _path: '/second' }))?.value, 'external edit')
    assert.equal(await markers.countDocuments(), count)
    assert.equal((await store.scan({ range: { journalHead: 'position' }, budget: scanBudget() })).items[0].pos.seq, 2)
    await physical.updateOne({ _path: '/second' }, { $unset: { value: '' } })
    await store.commit({ ...cleanup, maintenanceLimits: { changeSet: 2, budget: scanBudget() } })
    assert.equal(await physical.countDocuments(), 0)
    assert.equal(await markers.countDocuments(), count + 1)
  } finally { await store.close(); await client.close() }
})


it('retains the native archive collection barrier through cold pending transfer cleanup', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI
  assert.ok(uri)
  const db = `transfer_archive_${randomUUID().replaceAll('-', '')}`
  let store = await createMongoStore({ uri, db, collection: 'nodes', domain: db })
  const owner = 'owned-transfer-destination'
  const generation = position(1)
  try {
    await store.commit({ pos: generation, writerEpoch: 1, writes: [],
      blobArchive: [{ t: 'begin', owner, generation, transfer: { node: 'declaring-id',
        component: '#mount', base: '/mount', pattern: '*', source: 'owned-source',
        destination: owner, cursor: position(0), firstPage: 0 } },
      { t: 'seal', owner, generation, pages: 0 },
      { t: 'switchTransfer', owner, generation, pos: generation }],
      record: { pos: generation, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } })
    const unavailable = (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE'
    await assert.rejects(store.archivedBlobHolds(['unrelated-orphan'], 100, scanBudget()), unavailable)
    await store.close()
    store = await createMongoStore({ uri, db, collection: 'nodes', domain: db })
    await assert.rejects(store.archivedBlobHolds(['unrelated-orphan'], 100, scanBudget()), unavailable)
    const node = { ...storedNode('/ordinary'), $pos: position(2) }
    await store.commit({ pos: position(2), writerEpoch: 1, writes: [{ path: node.$path, node }],
      blobArchive: [{ t: 'completeTransfer', owner, generation }],
      record: { pos: position(2), kind: 'commit', executor: 'kernel', caller: 'kernel',
        entries: [{ id: node.$id, path: node.$path, change: { t: 'create', after: node } }] } })
    assert.equal((await store.archivedBlobHolds(['unrelated-orphan'], 100, scanBudget())).items[0].live, 0)
    assert.equal((await store.scan({ range: { node: '/ordinary' }, budget: scanBudget() })).items[0].$id, node.$id)
  } finally { await store.close() }
})
