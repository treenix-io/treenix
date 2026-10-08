import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import { openPersistentWriter } from '#kernel/persistence'
import { scanBudget, runStoreContract, storeCommit, storedNode } from './contract'
import { createFsStore } from './fs'
import { commitFrame } from './fs-journal'
import { isRecord } from '#util/is-record'
import { isUlid } from '#util/ulid'
import { createRegistry } from '#kernel/registry'
import { createWriter } from '#kernel/writer'
import { prepareChangeSet } from '#kernel/changeset'
import { readJournalImages } from '#kernel/journal'

const fixtures: { close(): Promise<void> }[] = []
const children: ChildProcess[] = []
const errorCode = (code: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === code
let failing = false

async function scratch(): Promise<string> {
  const parent = resolve('../../temp/k41-fs')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}
async function setup(directory?: string) {
  directory ??= await scratch()
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
  const store = await createFsStore({ directory, lease, checkpoint: stage => { if (failing && stage === 'beforeRecord') throw new Error('Injected filesystem failure') } })
  fixtures.push({ async close() { await store.close(); await lease.close() } })
  return { lease, store, directory }
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close()
})
runStoreContract(async () => (await setup()).store, { name: 'filesystem', async crash(run) { failing = true; try { await run() } finally { failing = false } } })

function child(mode: string, directory: string): ChildProcess {
  const process = fork(fileURLToPath(new URL('./fs-process-fixture.ts', import.meta.url)), [mode, directory], {
    execArgv: ['--conditions=development', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    signal: AbortSignal.timeout(10_000),
    env: { ...globalThis.process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '' },
  })
  children.push(process)
  return process
}
async function message(process: ChildProcess): Promise<Record<string, unknown>> {
  const result = await Promise.race([once(process, 'message'), once(process, 'exit').then(([code]) => { throw new Error(`Child exited before reporting: ${code}`) })])
  const value: unknown = result[0]
  assert.ok(isRecord(value))
  return value
}

describe('native filesystem persistence', { timeout: 30_000 }, () => {
  it('persists strong identity without path or version metadata in files and restores the exact accepted position', async () => {
    const first = await setup()
    const commit = storeCommit(1, [storedNode('/parent'), storedNode('/parent/child', { value: 7 })])
    await first.store.commit(commit)
    const body: unknown = JSON.parse(await readFile(join(first.directory, 'parent/child/$'), 'utf8'))
    assert.ok(typeof body === 'object' && body !== null)
    assert.equal('$path' in body || '$pos' in body || '$rev' in body, false)
    assert.equal(Reflect.get(body, '$id'), commit.writes[1].node.$id)
    await first.store.close(); await first.lease.close()
    const second = await setup(first.directory)
    assert.deepEqual((await second.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, commit.writes.map(write => write.node))
    assert.deepEqual((await second.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [commit.record])
    assert.equal(second.lease.domain, first.lease.domain)
    assert.equal(second.lease.epoch, first.lease.epoch)
    assert.ok(second.lease.writerEpoch > first.lease.writerEpoch)
    await assert.rejects(first.store.commit(commit), errorCode('CONFLICT'))
    await assert.rejects(second.store.commit(storeCommit(2, [storedNode('/stale')], [], first.lease.writerEpoch)), errorCode('CONFLICT'))
  })

  it('imports path identities and never persists a synthesized path identity', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'existing.json'), JSON.stringify({ $type: 'test.item', value: 1 }))
    const { store } = await setup(directory)
    const [before] = (await store.scan({ range: { node: '/existing' }, budget: scanBudget() })).items
    assert.equal(before.$id, 'p:/existing')
    await store.commit(storeCommit(1, [before]))
    assert.equal('$id' in JSON.parse(await readFile(join(directory, 'existing/$'), 'utf8')), false)
    await assert.rejects(store.commit(storeCommit(2, [{ ...before, $path: '/moved' }])), errorCode('INVALID'))
    assert.equal((await store.scan({ range: { node: '/existing' }, budget: scanBudget() })).items.length, 1)
  })

  it('moves a real path-identity node through native preparation as delete and newly minted create', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'old.json'), JSON.stringify({ $type: 'item', $v: 1, value: 7 }))
    const { store, lease } = await setup(directory), registry = createRegistry()
    registry.publish({ id: 'test', security: [], open: [], types: [{ name: 'item', module: 'test', security: 'ordinary', version: 1, schema: {}, actions: {} }] })
    const writer = await createWriter({ instance: 'test', root: store, counter: lease, writerEpoch: lease.writerEpoch,
      domains: [{ store, epoch: lease.epoch, persistent: true }], budget: scanBudget })
    const pos = await writer.commit(store, [], pos => prepareChangeSet({ store, registry, cache: writer.cache, budget: scanBudget() }, [{ op: 'move', from: '/old', to: '/new' }], pos))
    const [after] = (await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items
    assert.equal(after.$path, '/new'); assert.equal(after.value, 7); assert.ok(isUlid(after.$id))
    const records = (await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    assert.equal(readJournalImages(records, { pos, id: 'p:/old' }).after, null)
    assert.deepEqual(readJournalImages(records, { pos, id: after.$id }), { before: null, after })
    assert.equal(JSON.parse(await readFile(join(directory, 'new/$'), 'utf8')).$id, after.$id)
  })

  it('preserves JSON-shaped logical names, existing leaf nodes and legacy directory bodies during promotion', async () => {
    const directory = await scratch()
    await writeFile(join(directory, '$.json'), JSON.stringify({ $type: 'test.item', value: 'root' }))
    await writeFile(join(directory, 'a.json'), JSON.stringify({ $type: 'test.item', value: 'leaf' }))
    const { store, lease } = await setup(directory)
    const paths = ['/a.json', '/a.json/child', '/$.json', '/$.json/child', '/foo.tmp', '/foo.tmp/child', '/nested/.git', '/nested/.treenix']
    await store.commit(storeCommit(1, paths.map(path => storedNode(path, { value: path }))))
    const nodes = (await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items
    assert.deepEqual(nodes.map(node => node.$path).sort(), ['/', '/a', ...paths].sort())
    assert.equal(nodes.find(node => node.$path === '/')?.value, 'root')
    assert.equal(nodes.find(node => node.$path === '/a')?.value, 'leaf')
    const before = nodes.find(node => node.$path === '/a')
    assert.ok(before)
    const pos = { instance: 'test', epoch: 1, seq: 2 }
    await store.commit({ pos, writerEpoch: 1, writes: [{ path: '/a', node: null }], record: { pos, kind: 'commit', caller: 'kernel', executor: 'kernel', entries: [{ id: before.$id, path: '/a', change: { t: 'delete', before } }] } })
    assert.equal((await store.scan({ range: { subtree: '/a.json' }, budget: scanBudget() })).items.length, 2)
    await store.close(); await lease.close()
    const reopened = await setup(directory)
    assert.deepEqual((await reopened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$path).sort(), ['/', ...paths].sort())
  })

  it('rejects traversal, reserved metadata addresses and symlink escapes before journal acceptance', async () => {
    const { store, directory } = await setup(), outside = await scratch()
    await symlink(outside, join(directory, 'escape'), 'dir')
    for (const path of ['/../escaped', '/a/$', '/.treenix/overwrite', '/escape/deep/item']) {
      await assert.rejects(store.commit(storeCommit(1, [storedNode(path)])), error => error instanceof KernelError && ['INVALID', 'FORBIDDEN'].includes(error.code))
    }
    assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [])
    assert.deepEqual(await readdir(outside), [])
  })

  it('rejects lossy node serialization before recording a commit', async () => {
    const { store } = await setup()
    for (const value of [Number.NaN, Infinity, new Date(), undefined]) await assert.rejects(store.commit(storeCommit(1, [storedNode('/invalid', { value })])), errorCode('INVALID'))
    assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
    assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [])
  })

  it('rejects forbidden JSON keys in direct node writes and decision values before journal acceptance', async () => {
    const { store, lease, directory } = await setup()
    for (const name of ['constructor', 'prototype', '__proto__']) {
      const value: unknown = JSON.parse(`{"${name}":"unreadable"}`)
      await assert.rejects(store.commit(storeCommit(1, [storedNode('/invalid', { payload: [value] })])), errorCode('INVALID'))
      const commit = storeCommit(1, [])
      await assert.rejects(store.commit({ ...commit, record: { ...commit.record,
        decision: { opId: { epoch: 'test', time: 1, nonce: name }, requestHash: 'request', outcome: { value: [value] } } } }), errorCode('INVALID'))
    }
    assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
    assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [])
    assert.equal((await readFile(join(directory, '.treenix/journal.log'))).length, 0)
    await store.close(); await lease.close()
    const reopened = await setup(directory)
    assert.deepEqual((await reopened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
  })

  it('completes a fsynced multi-file commit after killing its writer process', async () => {
    for (const mode of ['crash', 'crash-partial']) {
      const directory = await scratch(), writer = child(mode, directory)
      assert.equal((await message(writer)).type, mode === 'crash' ? 'recordSynced' : 'nodeWritten')
      const exited = once(writer, 'exit'); writer.kill('SIGKILL'); await exited
      const reopened = child('recover', directory), recovered = await message(reopened)
      assert.deepEqual(recovered.nodes, storeCommit(1, [storedNode('/a', { value: 'complete' }), storedNode('/b', { value: 'complete' })]).writes.map(write => write.node))
      assert.deepEqual(recovered.journal, [storeCommit(1, [storedNode('/a', { value: 'complete' }), storedNode('/b', { value: 'complete' })]).record])
      await once(reopened, 'exit')
    }
  })

  it('keeps a truncated journal tail as a separate artifact and rejects corruption of a complete frame', async () => {
    const { store, lease, directory } = await setup()
    await store.commit(storeCommit(1, [storedNode('/accepted')]))
    await store.close(); await lease.close()
    const tail = commitFrame(storeCommit(2, [storedNode('/unaccepted')])).subarray(0, 41)
    await appendFile(join(directory, '.treenix/journal.log'), tail)
    const restored = await setup(directory)
    assert.deepEqual((await restored.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$path), ['/accepted'])
    const artifacts = (await readdir(join(directory, '.treenix'))).filter(name => name.endsWith('.partial'))
    assert.equal(artifacts.length, 1)
    assert.deepEqual(await readFile(join(directory, '.treenix', artifacts[0])), tail)
    await restored.store.close(); await restored.lease.close()
    const data = await readFile(join(directory, '.treenix/journal.log')); data[40] ^= 1
    await writeFile(join(directory, '.treenix/journal.log'), data)
    const rejectedLease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
    try { await assert.rejects(createFsStore({ directory, lease: rejectedLease }), errorCode('INVALID')) } finally { await rejectedLease.close() }
  })

  it('reopens the real native foundation in a new process without reminting identity, key or positions', async () => {
    const directory = await scratch(), first = child('instance', directory)
    const initial = await message(first); await once(first, 'exit')
    const second = child('instance-reopen', directory), reopened = await message(second); await once(second, 'exit')
    assert.deepEqual(reopened.bootstrap, initial.bootstrap)
    assert.deepEqual(reopened.account, initial.account)
    assert.deepEqual(reopened.key, initial.key)
    assert.ok(typeof reopened.pos === 'object' && reopened.pos !== null && typeof initial.pos === 'object' && initial.pos !== null)
    assert.ok(Reflect.get(reopened.pos, 'seq') > Reflect.get(initial.pos, 'seq'))
  })
})
