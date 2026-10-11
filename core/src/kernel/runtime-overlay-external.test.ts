import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { it } from 'node:test'
import { openPersistentWriter } from '#kernel/persistence'
import { computeFieldDeltas } from '#kernel/journal'
import { createFsStore } from '#kernel/store/fs'
import { createFsOverlayLayout } from '#kernel/store/fs-overlay'
import { DEFAULT_LIMITS, type StoreCommit } from '#kernel/types'
import { scanBudget } from '#kernel/store/contract'

it('reports real base, upper and whiteout edits through the same accepted Fs owner', { timeout: 10_000 }, async () => {
  const parent = resolve('../../temp/root-overlay-external-fixtures')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'instance-')), base = join(directory, 'base'), upper = join(directory, 'work')
  await mkdir(base)
  await writeFile(join(base, 'doc.json'), JSON.stringify({ $type: 'test.item', count: 1 }))
  const layout = await createFsOverlayLayout(upper, base)
  const lease = await openPersistentWriter({ instance: 'overlay-external', directory: join(upper, '.treenix') })
  const store = await createFsStore({ directory: upper, lease, layout, external: 'trusted' })
  const events = store.external!()[Symbol.asyncIterator]()
  const budget = () => ({ ...scanBudget(), deadline: Date.now() + DEFAULT_LIMITS.queryMs })
  try {
    const before = (await store.scan({ range: { node: '/doc' }, budget: budget() })).items[0]
    const fromBase = events.next()
    await writeFile(join(base, 'doc.json'), JSON.stringify({ $type: 'test.item', count: 2 }))
    const baseEvent = await fromBase
    assert.equal(baseEvent.done, false)
    assert.ok(Array.isArray(baseEvent.value))
    assert.ok(baseEvent.value!.includes('/doc'))
    const baseChanges = await store.readExternal!(baseEvent.value!, budget())
    const baseChange = baseChanges.items.find(change => 'before' in change && change.path === '/doc')!
    assert.ok('before' in baseChange)
    assert.ok(baseChange.before !== 'unknown')
    assert.equal(baseChange.before?.count, 1)
    assert.equal(baseChange.after?.count, 2)

    const fromUpper = events.next()
    await writeFile(join(upper, 'doc.json'), JSON.stringify({ $type: 'test.item', count: 3 }))
    const upperEvent = await fromUpper
    assert.equal(upperEvent.done, false)
    const visible = (await store.scan({ range: { node: '/doc' }, budget: budget() })).items[0]
    assert.equal(visible.count, 3)
    const pos = { ...before.$pos, seq: before.$pos.seq + 1 }, accepted = { ...visible, $pos: pos }
    const reconciliation: StoreCommit = { pos, writerEpoch: lease.writerEpoch,
      writes: [{ path: '/doc', node: accepted }], record: { pos, kind: 'reconcile', executor: 'kernel', caller: 'kernel',
        entries: [{ id: before.$id, path: '/doc', change: { t: 'update', after: accepted, delta: computeFieldDeltas(before, accepted) } }] } }
    await store.commit(reconciliation)
    const removed = { ...pos, seq: 2 }
    await store.commit({ pos: removed, writerEpoch: lease.writerEpoch, writes: [{ path: '/doc', node: null }],
      record: { pos: removed, kind: 'commit', executor: 'kernel', caller: 'kernel',
        entries: [{ id: accepted.$id, path: '/doc', change: { t: 'delete', before: accepted } }] } })
    assert.deepEqual((await store.scan({ range: { node: '/doc' }, budget: budget() })).items, [])

    const fromMetadata = events.next()
    const marker = join(upper, '.treenix/whiteouts', `${createHash('sha256').update('/doc').digest('hex')}.json`)
    await writeFile(marker, JSON.stringify({ path: '/doc', deleted: false }))
    const metadataEvent = await fromMetadata
    assert.equal(metadataEvent.done, false)
    assert.ok(Array.isArray(metadataEvent.value))
    const metadataChanges = await store.readExternal!(metadataEvent.value!, budget())
    const revealed = metadataChanges.items.find(change => 'before' in change && change.path === '/doc')!
    assert.ok('before' in revealed)
    assert.equal(revealed.before, null)
    assert.equal(revealed.after?.count, 2)
    assert.equal(await readFile(join(base, 'doc.json'), 'utf8'), JSON.stringify({ $type: 'test.item', count: 2 }))
  } finally {
    await store.close(); await events.return?.(); await lease.close()
  }
})
