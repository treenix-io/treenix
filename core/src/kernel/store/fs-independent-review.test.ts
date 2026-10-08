import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import { openPersistentWriter } from '#kernel/persistence'
import { prepareChangeSet } from '#kernel/changeset'
import { createRegistry } from '#kernel/registry'
import { createFsStore } from '#kernel/store/fs'
import { commitFrame } from '#kernel/store/fs-journal'
import { scanBudget, storeCommit, storedNode } from '#kernel/store/contract'
import { createWriter } from '#kernel/writer'
import { isRecord } from '#util/is-record'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
async function directory() {
  const parent = fileURLToPath(new URL('../../../../../temp/k41-independent-datasets/', import.meta.url))
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}
async function setup(input?: string) {
  const root = input ?? await directory()
  const lease = await openPersistentWriter({ directory: join(root, '.treenix'), instance: 'test' })
  try {
    const store = await createFsStore({ directory: root, lease })
    return { root, lease, store, async close() { await store.close(); await lease.close() } }
  } catch (error) { await lease.close(); throw error }
}

describe('independent filesystem review', { timeout: 30_000 }, () => {
  it('rejects imported addresses that the native Reader and writer cannot address', async () => {
    for (const name of ['a?b.json', 'a#b.json', 'a%2fb.json']) {
      const root = await directory()
      await writeFile(join(root, name), JSON.stringify({ $type: 'test.item' }))
      await assert.rejects(async () => {
        const opened = await setup(root)
        await opened.close()
      }, code('INVALID'))
    }
  })

  it('preserves complete decisions and rejects an apply checkpoint without its journal position', async () => {
    const first = await setup()
    const commit = storeCommit(1, [storedNode('/accepted')])
    const record = { ...commit.record, caller: 'u:review' as const,
      decision: { opId: { epoch: 'intake', time: 1, nonce: 'decision' }, requestHash: 'request', outcome: { pos: commit.pos, value: { accepted: true } } } }
    await first.store.commit({ ...commit, record }); await first.close()
    const reopened = await setup(first.root)
    assert.deepEqual((await reopened.store.scan({ range: { decision: { caller: record.caller, opId: record.decision.opId } }, budget: scanBudget() })).items, [record])
    await reopened.close()
    await writeFile(join(first.root, '.treenix/applied.json'), JSON.stringify({ instance: 'test', epoch: 1, seq: 99 }))
    await assert.rejects(setup(first.root), code('INVALID'))
  })

  it('preserves a torn tail byte for byte and rejects complete frame header corruption', async () => {
    const first = await setup()
    await first.store.commit(storeCommit(1, [storedNode('/accepted')]))
    await first.close()
    const journal = join(first.root, '.treenix/journal.log')
    const original = await readFile(journal), tail = Buffer.from([3, 9, 8, 7])
    await appendFile(journal, tail)
    const reopened = await setup(first.root)
    assert.deepEqual((await reopened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$path), ['/accepted'])
    await reopened.close()
    assert.deepEqual(await readFile(journal), original)
    const artifacts = (await readdir(join(first.root, '.treenix'))).filter(name => name.endsWith('.partial'))
    assert.equal(artifacts.length, 1)
    assert.deepEqual(await readFile(join(first.root, '.treenix', artifacts[0])), tail)
    const corrupt = Buffer.from(original); corrupt[4] ^= 1
    await writeFile(journal, corrupt)
    await assert.rejects(setup(first.root), code('INVALID'))
  })

  it('refuses a complete frame with foreign instance identity before applying files', async () => {
    const first = await setup(); await first.close()
    const base = storeCommit(1, [storedNode('/foreign')]), pos = { ...base.pos, instance: 'foreign' }
    const node = { ...base.writes[0].node, $pos: pos }
    const foreign = { ...base, pos, writes: [{ path: node.$path, node }], record: { ...base.record, pos,
      entries: [{ id: node.$id, path: node.$path, change: { t: 'create', after: node } as const }] } }
    await appendFile(join(first.root, '.treenix/journal.log'), commitFrame(foreign))
    await assert.rejects(setup(first.root), code('INVALID'))
    assert.deepEqual((await readdir(first.root)).sort(), ['.treenix'])
  })

  it('detects physical body drift and refuses a symlink body without modifying its target', async () => {
    const first = await setup()
    await first.store.commit(storeCommit(1, [storedNode('/accepted', { value: 'before' })])); await first.close()
    await writeFile(join(first.root, 'accepted/$'), JSON.stringify({ $type: 'test.item', $id: 'id:/accepted', value: 'after' }))
    await assert.rejects(setup(first.root), code('INVALID'))
    const open = await setup(), outside = await directory()
    await writeFile(join(outside, 'value.json'), 'unchanged')
    await mkdir(join(open.root, 'blocked'))
    await symlink(join(outside, 'value.json'), join(open.root, 'blocked/$'))
    try {
      await assert.rejects(open.store.commit(storeCommit(1, [storedNode('/blocked')])), code('FORBIDDEN'))
      assert.equal(await readFile(join(outside, 'value.json'), 'utf8'), 'unchanged')
      assert.deepEqual((await open.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [])
    } finally { await open.close() }
  })

  it('recovers an actual killed child and resumes its native Writer above durable positions', async () => {
    const root = await directory()
    const child = fork(fileURLToPath(new URL('./fs-process-fixture.ts', import.meta.url)), ['crash-partial', root], {
      execArgv: ['--conditions=development', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      signal: AbortSignal.timeout(10_000),
      env: { ...process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '' },
    })
    try {
      const [value]: unknown[] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Child exited before checkpoint') })])
      assert.ok(isRecord(value)); assert.equal(value.type, 'nodeWritten')
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      const reopened = await setup(root)
      try {
        assert.deepEqual((await reopened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$path), ['/a', '/b'])
        const writer = await createWriter({ instance: 'test', root: reopened.store, writerEpoch: reopened.lease.writerEpoch,
          counter: reopened.lease, domains: [{ store: reopened.store, persistent: true, epoch: reopened.lease.epoch }], budget: scanBudget })
        const pos = await writer.commit(reopened.store, [], pos => ({ writes: [], transitions: [],
          record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } }))
        assert.ok(pos.epoch > 1 || pos.epoch === 1 && pos.seq > 1)
      } finally { await reopened.close() }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    }
  })

  it('rejects forbidden JSON keys through real native preparation before making storage unreopenable', async () => {
    const opened = await setup(), registry = createRegistry()
    registry.publish({ id: 'review', types: [{ name: 'item', module: 'review', security: 'ordinary', schema: {}, version: 0, actions: {} }], security: [], open: [] })
    const writer = await createWriter({ instance: 'test', root: opened.store, counter: opened.lease, writerEpoch: opened.lease.writerEpoch,
      domains: [{ store: opened.store, persistent: true, epoch: opened.lease.epoch }], budget: scanBudget })
    const journal = (await opened.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    try {
      await assert.rejects(writer.commit(opened.store, [], pos => prepareChangeSet({ store: opened.store, registry, cache: writer.cache, budget: scanBudget() },
        [{ op: 'put', node: { $path: '/bad', $type: 'item', payload: { constructor: 'unreadable' } } }], pos)), code('INVALID'))
      assert.deepEqual((await opened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
      assert.deepEqual((await opened.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, journal)
    } finally { await opened.close() }
    const reopened = await setup(opened.root)
    try { assert.deepEqual((await reopened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, []) } finally { await reopened.close() }
  })
})
