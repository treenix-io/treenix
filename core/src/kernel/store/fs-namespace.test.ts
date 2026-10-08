import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { KernelError } from '#errors'
import { prepareChangeSet } from '#kernel/changeset'
import { computeFieldDeltas, encodeJournalEntry, readJournalImages } from '#kernel/journal'
import { openPersistentWriter } from '#kernel/persistence'
import { createRegistry } from '#kernel/registry'
import type { StoreCommit, StoredNode } from '#kernel/types'
import { createWriter } from '#kernel/writer'
import { isUlid } from '#util/ulid'
import { scanBudget, storeCommit, storedNode } from './contract'
import { createFsStore } from './fs'
import { decodeCommit, openFsJournal } from './fs-journal'

const resources: { close(): Promise<void> }[] = []
const children: ChildProcess[] = []
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Preserve unique datasets so a failed durability assertion remains inspectable. */
async function scratch(): Promise<string> {
  const parent = resolve('../../temp/k26-fs-namespace')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}

/** Acquire an actual owned Fs Store while keeping its public addresses logical. */
async function setup(logicalBase: string, directory?: string) {
  directory ??= await scratch()
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
  const options = { directory, lease, logicalBase }
  try {
    const store = await createFsStore(options)
    let closing: Promise<void> | undefined
    const resource = { close() { return closing ??= (async () => {
      try { await store.close() } finally { await lease.close() }
    })() } }
    resources.push(resource)
    return { store, lease, directory, close: resource.close }
  } catch (error) {
    await lease.close()
    throw error
  }
}

/** Inspect the persisted local representation through the actual journal decoder. */
async function localJournal(directory: string) {
  const journal = await openFsJournal(join(directory, '.treenix'))
  try { return journal.commits } finally { await journal.close() }
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  for (const resource of resources.splice(0).reverse()) await resource.close()
})

describe('filesystem logical namespace', { timeout: 45_000 }, () => {
  it('imports path identities into the logical namespace while retaining local files and user references', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'doc.json'), JSON.stringify({ $type: 'item', ref: { $ref: '/outside/doc' } }))
    const { store } = await setup('/mounted', directory)
    const result = await store.scan({ range: { node: '/mounted/doc' }, budget: scanBudget() })
    assert.equal(result.items.length, 1)
    const node = result.items[0]
    assert.equal(node.$id, 'p:/mounted/doc')
    assert.deepEqual(node.ref, { $ref: '/outside/doc' })
    assert.deepEqual((await store.scan({ range: { node: '/doc' }, budget: scanBudget() })).items, [])
    await store.commit(storeCommit(1, [node], [node]))
    const body = JSON.parse(await readFile(join(directory, 'doc/$'), 'utf8'))
    assert.equal('$id' in body, false)
    assert.equal('$path' in body, false)
    assert.deepEqual(body.ref, node.ref)
    assert.equal((await readdir(directory)).includes('mounted'), false)
  })

  it('filters, sorts and continues cursors against logical addresses and identities', async () => {
    const { store, directory } = await setup('/mounted')
    await store.commit(storeCommit(1, ['a', 'b', 'c'].map(name => ({
      ...storedNode(`/mounted/${name}`), $id: `p:/mounted/${name}`, score: 1,
    }))))
    const query = { range: { children: '/mounted' }, where: { $path: { $in: ['/mounted/a', '/mounted/b', '/mounted/c'] } },
      sort: [['$id', 1]] as const, limit: 2, budget: scanBudget() }
    const first = await store.scan(query)
    assert.deepEqual(first.items.map(node => node.$id), ['p:/mounted/a', 'p:/mounted/b'])
    assert.ok(first.next)
    const second = await store.scan({ ...query, after: first.next })
    assert.deepEqual(second.items.map(node => node.$id), ['p:/mounted/c'])
    assert.equal(second.next, undefined)
    assert.equal('$id' in JSON.parse(await readFile(join(directory, 'c/$'), 'utf8')), false)
  })

  it('moves an imported path identity through the real Writer and persists its newly issued identity', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'old.json'), JSON.stringify({ $type: 'item', value: 7 }))
    const { store, lease } = await setup('/mounted', directory)
    const registry = createRegistry()
    registry.publish({ id: 'test', types: [{ name: 'item', module: 'test', security: 'ordinary', version: 0,
      schema: {}, actions: {} }], security: [], open: [] })
    const writer = await createWriter({ instance: 'test', root: store, counter: lease, writerEpoch: lease.writerEpoch,
      domains: [{ store, epoch: lease.epoch, persistent: true }], budget: scanBudget })
    const pos = await writer.commit(store, [], position => prepareChangeSet({ store, registry, cache: writer.cache,
      budget: scanBudget() }, [{ op: 'move', from: '/mounted/old', to: '/mounted/new' }], position))
    const after = (await store.scan({ range: { node: '/mounted/new' }, budget: scanBudget() })).items[0]
    assert.equal(after.value, 7)
    assert.ok(isUlid(after.$id))
    const records = (await store.scan({ range: { journal: '/mounted' }, budget: scanBudget() })).items
    assert.equal(readJournalImages(records, { pos, id: 'p:/mounted/old' }).after, null)
    assert.deepEqual(readJournalImages(records, { pos, id: after.$id }), { before: null, after })
    assert.equal(JSON.parse(await readFile(join(directory, 'new/$'), 'utf8')).$id, after.$id)
  })

  it('keeps structural move deltas and images local in the WAL and logical in recovered history', async () => {
    const opened = await setup('/mounted')
    const first = storeCommit(1, [storedNode('/mounted/old', { ref: { $ref: '/mounted/old' } })])
    await opened.store.commit(first)
    const before = first.writes[0].node
    const pos = { instance: 'test', epoch: 1, seq: 2 }
    const after: StoredNode = { ...before, $path: '/mounted/new', $pos: pos }
    const decision = { opId: { epoch: 'original', time: 1, nonce: 'move' }, requestHash: 'original-hash',
      outcome: { pos, value: { $path: '/mounted/old', id: before.$id } },
      stream: { executor: 'n:executor' as const, target: before.$id } }
    const second: StoreCommit = { pos, writerEpoch: opened.lease.writerEpoch,
      writes: [{ path: before.$path, node: null }, { path: after.$path, node: after }],
      record: { pos, kind: 'commit', executor: 'n:executor', caller: 'u:caller', decision,
        entries: [encodeJournalEntry(before, after, 0, true).entry] } }
    await opened.store.commit(second)
    await opened.close()
    const persisted = (await localJournal(opened.directory))[1]
    assert.deepEqual(persisted.record.entries[0].path, '/new')
    assert.deepEqual(persisted.record.entries[0].from, '/old')
    const change = persisted.record.entries[0].change
    assert.equal(change.t, 'update')
    assert.ok(change.t === 'update')
    assert.deepEqual(change.delta.$path, { from: '/old', to: '/new' })
    assert.equal(change.after?.$path, '/new')
    assert.deepEqual(persisted.record.decision, decision)

    const reopened = await setup('/mounted', opened.directory)
    const records = (await reopened.store.scan({ range: { journal: '/mounted' }, budget: scanBudget() })).items
    assert.deepEqual(readJournalImages(records, { pos, id: before.$id }), { before, after })
    const replay = await reopened.store.scan({ range: { decision: { caller: 'u:caller', opId: decision.opId } }, budget: scanBudget() })
    assert.deepEqual(replay.items[0].decision, decision)
    assert.deepEqual(JSON.parse(await readFile(join(opened.directory, 'new/$'), 'utf8')).ref, before.ref)
  })

  it('reopens a local dataset under another logical base without altering issued ids or decisions', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'doc.json'), JSON.stringify({ $type: 'item', note: '/first/doc' }))
    const first = await setup('/first', directory)
    const pathNode = (await first.store.scan({ range: { node: '/first/doc' }, budget: scanBudget() })).items[0]
    assert.ok(pathNode)
    await first.store.commit(storeCommit(1, [pathNode, storedNode('/first/issued')], [pathNode]))
    await first.close()
    const second = await setup('/second', directory)
    const nodes = (await second.store.scan({ range: { subtree: '/second' }, budget: scanBudget() })).items
    assert.equal(nodes[0].$id, 'p:/second/doc')
    assert.equal(nodes[0].note, '/first/doc')
    assert.equal(nodes[1].$id, 'id:/first/issued')
    const record = (await second.store.scan({ range: { journal: '/second' }, budget: scanBudget() })).items.at(-1)
    assert.equal(record?.entries[0].id, 'p:/second/doc')
  })

  it('maps reconciliation, whole-image deltas and deletion anchors without persisting path identities', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'doc.json'), JSON.stringify({ $type: 'item', count: 1 }))
    const opened = await setup('/mounted', directory)
    const before = (await opened.store.scan({ range: { node: '/mounted/doc' }, budget: scanBudget() })).items[0]
    assert.ok(before)
    const position = (seq: number) => ({ instance: 'test', epoch: 1, seq })
    const reconciled: StoredNode = { ...before, count: 2, $pos: position(1) }
    await opened.store.commit({ pos: reconciled.$pos, writerEpoch: opened.lease.writerEpoch,
      writes: [{ path: reconciled.$path, node: reconciled }], record: { pos: reconciled.$pos,
        kind: 'reconcile', caller: 'external:fs', executor: 'external:fs',
        entries: [{ id: before.$id, path: before.$path, change: { t: 'reconcile', before, after: reconciled } }] } })
    const replaced: StoredNode = { ...reconciled, count: 3, $pos: position(2) }
    await opened.store.commit({ pos: replaced.$pos, writerEpoch: opened.lease.writerEpoch,
      writes: [{ path: replaced.$path, node: replaced }], record: { pos: replaced.$pos,
        kind: 'commit', caller: 'kernel', executor: 'kernel', entries: [{ id: before.$id, path: before.$path,
          change: { t: 'update', after: replaced, delta: {
            '': { from: reconciled, to: replaced },
          } } }] } })
    const compacted: StoredNode = { ...replaced, count: 4, $pos: position(3) }
    await opened.store.commit({ pos: compacted.$pos, writerEpoch: opened.lease.writerEpoch,
      writes: [{ path: compacted.$path, node: compacted }], record: { pos: compacted.$pos,
        kind: 'commit', caller: 'kernel', executor: 'kernel', entries: [{ id: before.$id, path: before.$path,
          change: { t: 'update', delta: { ...computeFieldDeltas(replaced, compacted),
            $id: { from: before.$id, to: before.$id } } } }] } })
    await opened.store.commit({ pos: position(4), writerEpoch: opened.lease.writerEpoch,
      writes: [{ path: compacted.$path, node: null }], record: { pos: position(4),
        kind: 'commit', caller: 'kernel', executor: 'kernel',
        entries: [{ id: before.$id, path: before.$path, change: { t: 'delete', before: compacted } }] } })
    const discovered: StoredNode = { ...before, $id: 'p:/mounted/new', $path: '/mounted/new', $pos: position(5) }
    await opened.store.commit({ pos: discovered.$pos, writerEpoch: opened.lease.writerEpoch,
      writes: [{ path: discovered.$path, node: discovered }], record: { pos: discovered.$pos,
        kind: 'reconcile', caller: 'external:fs', executor: 'external:fs',
        entries: [{ id: discovered.$id, path: discovered.$path, change: { t: 'reconcile', after: discovered } }] } })
    await opened.close()

    const snapshot = decodeCommit(await readFile(join(directory, '.treenix/snapshot.json'), 'utf8'))
    assert.equal(snapshot.writes[0].node?.$id, 'p:/doc')
    const local = await localJournal(directory)
    const delta = local[1].record.entries[0].change
    assert.ok(delta.t === 'update')
    const compact = local[2].record.entries[0].change
    assert.ok(compact.t === 'update')
    assert.deepEqual(compact.delta.$id, { from: 'p:/doc', to: 'p:/doc' })
    assert.deepEqual(delta.delta[''], { from: { ...reconciled, $path: '/doc', $id: 'p:/doc' },
      to: { ...replaced, $path: '/doc', $id: 'p:/doc' } })
    assert.equal('$id' in JSON.parse(await readFile(join(directory, 'new/$'), 'utf8')), false)

    const reopened = await setup('/mounted', directory)
    const records = (await reopened.store.scan({ range: { journal: '/mounted' }, budget: scanBudget() })).items
    assert.deepEqual(readJournalImages(records, { pos: position(1), id: before.$id }), { before, after: reconciled })
    assert.deepEqual(readJournalImages(records, { pos: position(2), id: before.$id }), { before: reconciled, after: replaced })
    assert.deepEqual(readJournalImages(records, { pos: position(3), id: before.$id }), { before: replaced, after: compacted })
    assert.deepEqual(readJournalImages(records, { pos: position(4), id: before.$id }), { before: compacted, after: null })
    assert.deepEqual(readJournalImages(records, { pos: position(5), id: discovered.$id }), { before: 'unknown', after: discovered })
  })

  it('keeps identical local filenames distinct in different logical namespaces', async () => {
    const ids: string[] = []
    for (const base of ['/left', '/right']) {
      const directory = await scratch()
      await writeFile(join(directory, 'doc.json'), JSON.stringify({ $type: 'item', value: base }))
      const { store } = await setup(base, directory)
      const nodes = (await store.scan({ range: { node: `${base}/doc` }, budget: scanBudget() })).items
      assert.equal(nodes.length, 1)
      ids.push(nodes[0].$id)
    }
    assert.deepEqual(ids, ['p:/left/doc', 'p:/right/doc'])
  })

  it('rejects a noncanonical logical base at the deployment boundary', async () => {
    for (const base of ['relative', '/mounted/', '/mounted?query']) {
      await assert.rejects(setup(base), code('INVALID'))
    }
  })

  it('rejects outside-prefix and local reserved addresses before accepting a journal frame', async () => {
    const { store, directory } = await setup('/mounted')
    for (const path of ['/outside', '/mounted-other/doc', '/mounted/.treenix/overwrite', '/mounted/a/$']) {
      await assert.rejects(store.commit(storeCommit(1, [storedNode(path)])), code('INVALID'))
    }
    assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
    assert.equal((await readFile(join(directory, '.treenix/journal.log'))).length, 0)
  })

  it('recovers logical data and history after an actual process dies after WAL fsync or a partial apply', async () => {
    for (const stage of ['recordSynced', 'nodeWritten']) {
      const directory = await scratch()
      const child = fork(fileURLToPath(new URL('./fs-namespace-process-fixture.ts', import.meta.url)), [directory, stage], {
        execArgv: ['--conditions=development', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        signal: AbortSignal.timeout(10_000), env: { ...process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '' },
      })
      children.push(child)
      const received = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Child exited before checkpoint') })])
      assert.deepEqual(received[0], { stage })
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      const reopened = await setup('/mounted', directory)
      const nodes = (await reopened.store.scan({ range: { subtree: '/mounted' }, budget: scanBudget() })).items
      assert.deepEqual(nodes.map(node => node.$path), ['/mounted/a', '/mounted/b'])
      const records = (await reopened.store.scan({ range: { journal: '/mounted' }, budget: scanBudget() })).items
      assert.deepEqual(records[0].entries.map(entry => entry.path), ['/mounted/a', '/mounted/b'])
      assert.equal(JSON.parse(await readFile(join(directory, 'b/$'), 'utf8')).value, 'complete')
    }
  })
})
