import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, afterEach } from 'node:test'
import { KernelError } from '#errors'
import { createFsStore, type FsStoreOptions } from '#kernel/store/fs'
import { scanBudget, storedNode, storeCommit } from '#kernel/store/contract'
import { openPersistentWriter } from '#kernel/persistence'
import { createWriter, type Writer } from '#kernel/writer'
import { computeFieldDeltas, readJournalImages } from '#kernel/journal'
import { requestHash, type MutationIdentity } from '#kernel/idempotency'
import { createMemoryStore } from '#kernel/store/memory'
import { maintenanceRecord } from '#kernel/maintenance'
import { decodeCommit } from '#kernel/store/fs-journal'
import { openFsMountTarget } from '#kernel/mount-fs'
import { openNativeRuntime } from '#kernel/runtime'
import { drainSession } from '#kernel/session-delivery'
import type { Actor, StoredNode } from '#kernel/types'

const fixtures: { close(): Promise<void> }[] = []
const code = (expected: KernelError['code']) =>
  (error: unknown) => error instanceof KernelError && error.code === expected
const actor: Actor = { principal: 'u:one', claims: ['u:one'], scope: ['/'] }
const noExecution = async () => {
  throw new Error('A retained decision executed again')
}

/** Keep unique datasets and publication evidence inside the isolated project. */
async function scratch() {
  const parent = resolve('../../temp/fs-retention-tests')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}

/** Acquire real Fs authority and preserve its ownership across explicit reopen tests. */
async function setup(
  clock = { value: 1000 },
  directory?: string,
  checkpoint?: FsStoreOptions['checkpoint'],
  logicalBase = '/',
  retention = 100
) {
  directory ??= await scratch()
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
  const store = await createFsStore({
    directory,
    lease,
    external: 'none',
    checkpoint,
    logicalBase
  })
  const writer = await createWriter({
    instance: 'test',
    root: store,
    counter: lease,
    writerEpoch: lease.writerEpoch,
    domains: [{ store, epoch: lease.epoch, persistent: true }],
    budget: scanBudget,
    intake: { now: () => clock.value, limits: { opIdWindowMs: 500, clockToleranceMs: 50 } },
    maintenance: { now: () => clock.value, retentionMs: () => retention }
  })
  const close = async () => {
    await writer.closeTargets();
    await store.close();
    await lease.close()
  }
  fixtures.push({ close })
  return { directory, lease, store, writer, clock, close }
}

/** Commit compact update entries through the production Writer's domain span. */
async function put(
  writer: Writer,
  store: Parameters<Writer['commit']>[0],
  value: number,
  before?: StoredNode,
  path = '/item'
) {
  return writer.commit(store, [], pos => {
    const node = { ...before ?? storedNode(path), $pos: pos, value }
    return {
      writes: [{ path: node.$path, node }],
      record: {
        pos,
        kind: 'commit',
        executor: 'kernel',
        caller: 'kernel',
        entries: [{
          path: node.$path,
          id: node.$id,
          change: before === undefined
            ? { t: 'create', after: node }
            : { t: 'update', delta: computeFieldDeltas(before, node) }
        }]
      }
    }
  })
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close()
})

it('accepts a zero retention interval and drains owned maintenance without recursion', async () => {
  const f = await setup({ value: 1000 }, undefined, undefined, '/', 0)

  await put(f.writer, f.store, 1)
  await f.writer.maintain()

  assert.equal((await f.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value, 1)
  await f.close()
  const selected = await readFile(join(f.directory, '.treenix/generation.json'), 'utf8')
  assert.ok(selected.length > 0)
})

for (const phase of ['before root maintenance', 'between root and target maintenance'] as const) {
  it(`cancels optional maintenance after owned target retirement ${phase}`, { timeout: 10_000 }, async () => {
    const directory = await scratch(), clock = { value: 1000 }
    const rootLease = await openPersistentWriter({
      directory: join(directory, 'root/.treenix'),
      instance: 'test'
    })

    let entered: () => void = () => {}, release: () => void = () => {}, pause = false
    const rootEntered = new Promise<void>(resolve => { entered = resolve })
    const rootRelease = new Promise<void>(resolve => { release = resolve })
    const root = await createFsStore({
      directory: join(directory, 'root'),
      lease: rootLease,
      external: 'none',
      checkpoint: async stage => {
        if (pause && stage === 'recordSynced') {
          pause = false;
          entered();
          await rootRelease
        }
      }
    })
    const target = await openFsMountTarget({
      directory: join(directory, 'mounted'),
      instance: 'test',
      logicalBase: '/mounted',
      external: 'none'
    })
    const other = createMemoryStore({ domain: 'other' })
    const registration = { key: 'mounted', revision: 'revision', target }
    const writer = await createWriter({
      instance: 'test',
      root,
      counter: rootLease,
      writerEpoch: rootLease.writerEpoch,
      domains: [
        { store: root, epoch: rootLease.epoch, persistent: true },
        { store: other, epoch: 'other:1', persistent: false }
      ],
      startupTargets: [registration], targetLifecycle: {
        validate(value) { assert.equal(value, registration) },
        publish(value) { assert.equal(value.registration, registration) },
      },
      budget: scanBudget,
      intake: { now: () => clock.value, limits: { opIdWindowMs: 500, clockToleranceMs: 50 } },
      maintenance: { now: () => clock.value, retentionMs: () => 100 }
    })
    fixtures.push({
      async close() {
        release();
        await writer.closeTargets();
        await root.close();
        await rootLease.close();
        other.close()
      }
    })
    await writer.activateTarget(registration)
    const savedRoot: MutationIdentity = {
      actor,
      request: { root: true },
      opId: { epoch: writer.intake.epoch, time: 1000, nonce: 'root' }
    }
    const savedOther: MutationIdentity = {
      actor,
      request: { other: true },
      opId: { epoch: writer.intake.epoch, time: 1000, nonce: 'other' }
    }
    const save = (store: Parameters<Writer['commit']>[0], input: MutationIdentity) =>
      writer.mutate(input, span => span.finish(store, [], pos => ({
        writes: [],
        transitions: [],
        value: input.request,
        record: {
          pos,
          kind: 'commit',
          executor: actor.principal,
          caller: actor.principal,
          entries: []
        }
      })))
    const rootOutcome = await save(root, savedRoot), otherOutcome = await save(other, savedOther)

    let retiring: ReturnType<Writer['retireTarget']> | undefined
    const dispose = writer.stream.observe(event => {
      if (phase === 'before root maintenance' && event.t === 'commit'
        && event.domain === target.store.domain && event.record.kind === 'commit')
        retiring = writer.retireTarget(registration.key, registration.revision)
    })
    clock.value = 1200
    pause = phase === 'between root and target maintenance'

    await put(writer, target.store, 1, undefined, '/mounted/item')
    if (phase === 'between root and target maintenance') {
      await rootEntered
      retiring = writer.retireTarget(registration.key, registration.revision)
      release()
    }
    assert.ok(retiring)
    await retiring
    dispose()
    await writer.maintain(root)

    await put(writer, root, 2)
    await put(writer, other, 3, undefined, '/other')
    assert.deepEqual(await writer.mutate(savedRoot, noExecution), rootOutcome)
    assert.deepEqual(await writer.mutate(savedOther, noExecution), otherOutcome)
    assert.equal((await root.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value, 2)
    assert.equal((await other.scan({ range: { node: '/other' }, budget: scanBudget() })).items[0].value, 3)
    await assert.rejects(
      async () => target.store.scan({ range: { subtree: '/mounted' }, budget: scanBudget() }),
      code('CONFLICT')
    )
  })
}

it('adopts untimed legacy history durably and retires it after a full retention horizon', async () => {
  const directory = await scratch(), clock = { value: 1000 }
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
  const store = await createFsStore({ directory, lease, external: 'none' })
  const legacy: MutationIdentity = {
    actor,
    request: { legacy: true },
    opId: { epoch: 'legacy-intake', time: 950, nonce: 'legacy' }
  }
  let expected: { value: string; pos: StoredNode['$pos'] } | undefined
  for (let seq = 1; seq <= 8; seq++) {
    const commit = storeCommit(
      seq,
      [storedNode('/item', { value: seq, padding: 'x'.repeat(1000) })],
      [],
      lease.writerEpoch
    )
    if (seq === 8) {
      expected = { value: 'legacy-terminal', pos: commit.pos }
      await store.commit({ ...commit, record: { ...commit.record, caller: actor.principal,
        decision: { opId: legacy.opId, requestHash: requestHash(legacy.request, actor), outcome: expected },
        intake: { epoch: legacy.opId.epoch, boundary: 0, domains: { [lease.domain]: lease.epoch } } } })
    } else await store.commit(commit)
  }
  const writer = await createWriter({
    instance: 'test',
    root: store,
    counter: lease,
    writerEpoch: lease.writerEpoch,
    domains: [{ store, epoch: lease.epoch, persistent: true }],
    intake: { now: () => clock.value },
    maintenance: { now: () => clock.value, retentionMs: () => 100 }
  })
  fixtures.push({ async close() { await writer.closeTargets(); await store.close(); await lease.close() } })
  await writer.maintain()
  const first: { journal: string } = JSON.parse(
    await readFile(join(directory, '.treenix/generation.json'), 'utf8')
  )
  const adoptedSize = (await stat(join(directory, '.treenix', first.journal))).size
  assert.equal((await store.scan({ range: { journal: '/item' }, budget: scanBudget() })).items.length, 8)
  await writer.closeTargets(); await store.close(); await lease.close()
  clock.value = 1200
  const reopened = await setup(clock, directory)
  await reopened.writer.maintain()
  const selected: { journal: string } = JSON.parse(
    await readFile(join(directory, '.treenix/generation.json'), 'utf8')
  )
  assert.ok((await stat(join(directory, '.treenix', selected.journal))).size < adoptedSize / 2)
  assert.deepEqual(
    (await reopened.store.scan({ range: { journal: '/item' }, budget: scanBudget() })).items,
    []
  )
  assert.equal(
    (await reopened.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value,
    8
  )
  assert.deepEqual(await reopened.writer.mutate(legacy, noExecution), expected)
})

it('writer retention reduces the active filesystem journal and preserves accepted images', async () => {
  const parent = resolve('../../temp/fs-retention-tests')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'dataset-'))
  let clock = 1000
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
  const store = await createFsStore({ directory, lease, external: 'none' })
  try {
    const writer = await createWriter({
      instance: 'test',
      root: store,
      counter: lease,
      writerEpoch: lease.writerEpoch,
      domains: [{ store, epoch: lease.epoch, persistent: true }],
      intake: { now: () => clock },
      maintenance: { now: () => clock, retentionMs: () => 100 }
    })
    for (let value = 0; value < 12; value++) await writer.commit(store, [], pos => {
      const node = { ...storedNode('/item', { value, padding: 'x'.repeat(1000) }), $pos: pos }
      return {
        writes: [{ path: '/item', node }],
        record: {
          pos,
          kind: 'commit',
          executor: 'kernel',
          caller: 'kernel',
          entries: [{ path: '/item', id: node.$id, change: { t: 'create', after: node } }]
        }
      }
    })
    const before = (await stat(join(directory, '.treenix/journal.log'))).size
    clock += 200
    await writer.maintain(store)
    const selected: { snapshot: string; journal: string } = JSON.parse(
      await readFile(join(directory, '.treenix/generation.json'), 'utf8')
    )
    assert.ok((await stat(join(directory, '.treenix', selected.journal))).size < before)
    assert.equal((await store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value, 11)
    const records = (await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    assert.ok(records.some(record =>
      record.kind === 'kernel' && record.maintenance !== undefined && record.entries.length === 0))
    assert.ok((await readdir(join(directory, '.treenix'))).includes('journal.log'))
  } finally { await store.close(); await lease.close() }
})

it('keeps compact before and after anchors, quarantine and path identity through generation reopen', async () => {
  const directory = await scratch()
  await writeFile(join(directory, 'item.json'), JSON.stringify({ $type: 'test.item', value: 0 }))
  const clock = { value: 1000 }, first = await setup(clock, directory, undefined, '/mounted')
  let node = (await first.store.scan({ range: { node: '/mounted/item' }, budget: scanBudget() })).items[0]
  assert.equal(node.$id, 'p:/mounted/item')
  await put(first.writer, first.store, 1, node)
  clock.value += 80
  node = (await first.store.scan({ range: { node: '/mounted/item' }, budget: scanBudget() })).items[0]
  const keptPosition = await put(first.writer, first.store, 2, node)
  await first.writer.commit(first.store, [], pos => ({ writes: [], transitions: [],
    record: { pos, kind: 'reconcile', executor: 'external:data', caller: 'external:data', entries: [],
      quarantine: [{ path: '/mounted/blocked', fault: { code: 'INVALID', invalid: 'chain' } }] } }))
  clock.value += 50
  await first.writer.maintain()
  const expected = (await first.store.scan({ range: { subtree: '/mounted' }, budget: scanBudget() })).items
  await first.close()
  const second = await setup(clock, directory, undefined, '/mounted')
  assert.deepEqual(
    (await second.store.scan({ range: { subtree: '/mounted' }, budget: scanBudget() })).items,
    expected
  )
  assert.deepEqual(second.store.acceptedFault?.('/mounted/blocked'), { code: 'INVALID', invalid: 'chain' })
  const records = (await second.store.scan({
    range: { journal: '/mounted/item' },
    budget: scanBudget()
  })).items
  assert.equal(records.length, 1)
  const images = readJournalImages(records, { pos: keptPosition, id: 'p:/mounted/item' })
  assert.ok(images.before !== 'unknown')
  assert.equal(images.before?.value, 1)
  assert.equal(images.after?.value, 2)
  assert.equal(images.after?.$id, 'p:/mounted/item')
})

it(
  'preserves both terminal decision hashes and outcomes while pruning only below durable root expiry',
  async () => {
  const f = await setup(), epoch = f.writer.intake.epoch
  const expired: MutationIdentity = {
    actor,
    opId: { epoch, time: 1000, nonce: 'expired' },
    request: { old: true }
  }
  const original: MutationIdentity = {
    actor,
    opId: { epoch, time: 1150, nonce: 'original' },
    request: { first: true }
  }
  const continuing: MutationIdentity = {
    actor,
    opId: { epoch, time: 1160, nonce: 'continuing' },
    request: { continue: true }
  }
  const stream = { executor: actor.principal, target: 'item' }
  const oldOutcome = await f.writer.mutate(expired, span => span.finish(f.store, [], pos => ({
    writes: [],
    transitions: [],
    value: 'old',
    record: {
      pos,
      kind: 'commit',
      executor: actor.principal,
      caller: actor.principal,
      entries: []
    }
  })))
  assert.equal(oldOutcome.value, 'old')
  f.clock.value = 1200
  let expected: { value: { terminal: number }; pos: typeof f.writer.position } | undefined
  await f.writer.commit(f.store, [], pos => {
    expected = { value: { terminal: 7 }, pos }
    return {
      writes: [],
      transitions: [],
      record: {
        pos,
        kind: 'commit',
        executor: actor.principal,
        caller: actor.principal,
        entries: [],
        decision: {
          opId: continuing.opId,
          requestHash: requestHash(continuing.request, actor),
          stream,
          outcome: expected
        },
        anchorDecision: {
          opId: original.opId,
          requestHash: requestHash(original.request, actor),
          stream,
          outcome: expected
        }
      }
    }
  })
  f.clock.value = 1600
  await f.writer.maintain()
  assert.equal(f.writer.intake.boundary, 1100)
  assert.deepEqual(await f.writer.mutate(original, noExecution), expected)
  assert.deepEqual(await f.writer.mutate(continuing, noExecution), expected)
  await assert.rejects(
    f.writer.mutate({ ...original, request: { different: true } }, noExecution),
    code('KEY_REUSED')
  )
  assert.deepEqual(
    (await f.store.scan({
      range: { decision: { caller: actor.principal, opId: expired.opId } },
      budget: scanBudget()
    })).items,
    []
  )
  await assert.rejects(f.writer.mutate(expired, noExecution), code('EXPIRED'))
  const durable = f.writer.intake.boundary
  f.clock.value = 1200
  await f.writer.maintain()
  assert.equal(f.writer.intake.boundary, durable)
  await f.close()
  const reopened = await setup(f.clock, f.directory)
  assert.equal(reopened.writer.intake.boundary, durable)
  assert.deepEqual(await reopened.writer.mutate(original, noExecution), expected)
  assert.deepEqual(await reopened.writer.mutate(continuing, noExecution), expected)
  await assert.rejects(reopened.writer.mutate(expired, noExecution), code('EXPIRED'))
})

it('resets older journal cursors and preserves concurrent writes during publication', async () => {
  let release: () => void = () => {}, entered: () => void = () => {}
  const barrier = new Promise<void>(resolve => { release = resolve })
  const publishing = new Promise<void>(resolve => { entered = resolve })
  let pause = false
  const f = await setup({ value: 1000 }, undefined, async stage => {
    if (pause && stage === 'journalSynced') {
      entered();
      await barrier
    }
  })
  await put(f.writer, f.store, 1)
  const old = f.writer.stream.cursor()
  f.clock.value = 1200;
  pause = true
  const maintenance = f.writer.maintain()
  await publishing
  const write = put(f.writer, f.store, 2)
  release()
  await Promise.all([maintenance, write])
  const replay = f.writer.stream.follow(old)[Symbol.asyncIterator]()
  const first = await replay.next()
  assert.equal(first.done, false)
  assert.equal(first.value.t, 'reset')
  await replay.return?.()
  assert.equal(
    (await f.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value,
    2
  )
  await f.close()
  const reopened = await setup(f.clock, f.directory)
  assert.equal(
    (await reopened.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value,
    2
  )
})

it('retains external reconciliation images and retires only superseded selected generations', async () => {
  const f = await setup()
  await put(f.writer, f.store, 1)
  const before = (await f.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0]
  const { $path, $pos, ...body } = before
  await writeFile(join(f.directory, 'item', '$'), JSON.stringify({ ...body, value: 2 }))
  f.clock.value = 1080
  const externalPos = await f.writer.commit(f.store, [], pos => {
    const node = { ...before, value: 2, $pos: pos }
    return {
      writes: [{ path: node.$path, node }],
      record: {
        pos,
        kind: 'reconcile',
        executor: 'external:files',
        caller: 'external:files',
        entries: [{ path: node.$path, id: node.$id, change: { t: 'reconcile', after: node } }]
      }
    }
  })
  f.clock.value = 1130
  await f.writer.maintain()
  const records = (await f.store.scan({ range: { journal: '/item' }, budget: scanBudget() })).items
  const images = readJournalImages(records, { pos: externalPos, id: before.$id })
  assert.deepEqual(images.before, before)
  assert.equal(images.after?.value, 2)
  const first: { snapshot: string; journal: string } = JSON.parse(
    await readFile(join(f.directory, '.treenix/generation.json'), 'utf8')
  )
  await f.writer.maintain()
  const names = await readdir(join(f.directory, '.treenix'))
  assert.equal(names.includes(first.snapshot), false)
  assert.equal(names.includes(first.journal), false)
  assert.equal(names.filter(name => /^snapshot-.*\.json$/.test(name)).length, 1)
  assert.equal(names.filter(name => /^journal-.*\.log$/.test(name)).length, 1)
  await f.close()
  const reopened = await setup(f.clock, f.directory)
  const retained = (await reopened.store.scan({ range: { journal: '/item' }, budget: scanBudget() })).items
  assert.deepEqual(readJournalImages(retained, { pos: externalPos, id: before.$id }), images)
})

for (const stage of ['snapshotSynced', 'journalSynced', 'generationSynced'] as const) {
  it(
    `recovers a complete filesystem generation after process death at ${stage}`,
    { timeout: 10_000 },
    async () => {
    const directory = await scratch()
    const child = fork(
      fileURLToPath(new URL('./maintenance-process-fixture.ts', import.meta.url)),
      [directory, stage],
      {
        execArgv: ['--conditions=development', '--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        signal: AbortSignal.timeout(8000),
        env: { ...process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '' },
      }
    )
    try {
      const message = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
          throw new Error('Publication child ended before checkpoint')
        })
      ])
      assert.deepEqual(message[0], { stage })
      child.kill('SIGKILL')
      await once(child, 'exit')
      const reopened = await setup({ value: 1200 }, directory)
      assert.equal(
        (await reopened.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value,
        9
      )
      const records = (await reopened.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items
      assert.ok(records.some(record => record.kind === 'kernel' && record.maintenance !== undefined))
      const names = await readdir(join(directory, '.treenix'))
      assert.equal(names.includes('generation.json'), stage === 'generationSynced')
      await put(reopened.writer, reopened.store, 10)
      await reopened.close()
      const again = await setup({ value: 1200 }, directory)
      assert.equal(
        (await again.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value,
        10
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit')
      }
    }
  })
}

it(
  'runs retention from real WriterSession writes to an owned mounted filesystem',
  { timeout: 10_000 },
  async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const directory = await scratch(), data = join(directory, 'data')
  await mkdir(data)
  await writeFile(join(data, 'doc.json'), JSON.stringify({ $type: 't.dir', value: 0 }))
  const input = {
    id: 'session-retention',
    directory: join(directory, 'root'),
    modules: [],
    mountDirectories: { data },
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'retention-password' }
  }
  const runtime = await openNativeRuntime(input)
  assert.ok(runtime.instance.setupCredential)
  const credential = runtime.instance.setupCredential
  const admin = await runtime.instance.openSession(credential)
  const delivery = drainSession(admin)
  t.after(async () => { await runtime.close(); await delivery })
  let nonce = 0
  const key = () => ({
    epoch: runtime.instance.writer.intake.epoch,
    time: Date.now(),
    nonce: `session-${nonce++}`
  })
  await admin.commit({
    opId: key(),
    changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { journalRetentionMs: 100 } } }]
  }).outcome
  await admin.commit({
    opId: key(),
    changes: [{
      op: 'put',
      node: {
        $path: '/files',
        $type: 't.dir',
        '#mount': { $type: 't.mount.fs', directory: 'data', pattern: '', external: 'none' },
        '#groups': { $type: 't.groups', list: ['admins'] }
      }
    }]
  }).outcome
  const initial = await admin.read({ node: '/files/doc' })
  assert.ok('node' in initial.copies[0])
  assert.equal(initial.copies[0].node.$id, 'p:/files/doc')
  for (let value = 1; value < 7; value++) await admin.commit({
    opId: key(),
    changes: [{ op: 'patch', path: '/files/doc', ops: { $set: { value } } },]
  }).outcome
  const before = (await stat(join(data, '.treenix/journal.log'))).size
  let finish: () => void = () => {}, fail: (error: unknown) => void = () => {}
  const maintained = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
  const dispose = runtime.instance.writer.stream.observe(event => {
    if (event.t !== 'gap') return
    void (async () => {
      const directory = join(data, '.treenix')
      if (!(await readdir(directory)).includes('generation.json')) return
      const selected: { journal: string } = JSON.parse(await readFile(join(directory, 'generation.json'), 'utf8'))
      const journal = await readFile(join(directory, selected.journal))
      for (let offset = 0; offset < journal.length;) {
        const length = journal.readUInt32BE(offset)
        const commit = decodeCommit(journal.subarray(offset + 40, offset + 40 + length).toString('utf8'))
        if (commit.record.maintenance !== undefined && commit.pos.instance === event.pos.instance
          && commit.pos.epoch === event.pos.epoch && commit.pos.seq === event.pos.seq) finish()
        offset += 40 + length
      }
    })().catch(fail)
  })
  t.mock.timers.tick(150)
  const mutation = {
    opId: key(),
    changes: [{ op: 'patch' as const, path: '/files/doc', ops: { $set: { value: 7 } } }]
  }
  const outcome = await admin.commit(mutation).outcome
  await maintained
  dispose()
  const selected: { journal: string } = JSON.parse(
    await readFile(join(data, '.treenix/generation.json'), 'utf8')
  )
  assert.ok((await stat(join(data, '.treenix', selected.journal))).size < before)
  const journal = await readFile(join(data, '.treenix', selected.journal))
  let offset = 0, maintenanceFound = false
  while (offset < journal.length) {
    const length = journal.readUInt32BE(offset)
    const commit = decodeCommit(journal.subarray(offset + 40, offset + 40 + length).toString('utf8'))
    if (commit.record.maintenance !== undefined) {
      assert.equal(commit.record.executor, 'kernel')
      assert.equal(commit.record.entries.length, 0)
      maintenanceFound = true
    }
    offset += 40 + length
  }
  assert.equal(maintenanceFound, true)
  assert.deepEqual(await admin.commit(mutation).outcome, outcome)
  await runtime.close();
  await delivery
  const reopened = await openNativeRuntime(input)
  const session = await reopened.instance.openSession(credential),
    reopenedDelivery = drainSession(session)
  t.after(async () => { await reopened.close(); await reopenedDelivery })
  const restored = await session.read({ node: '/files/doc' })
  assert.ok('node' in restored.copies[0])
  assert.equal(restored.copies[0].node.value, 7)
  assert.equal(restored.copies[0].node.$id, 'p:/files/doc')
  assert.deepEqual(await session.commit(mutation).outcome, outcome)
})

it('fails the storage owner closed after a failure following durable generation selection', async () => {
  const injected = new Error('Injected publication failure')
  let fail = false
  const f = await setup({ value: 1000 }, undefined, stage => {
    if (fail && stage === 'generationSynced') throw injected
  })
  await put(f.writer, f.store, 4)
  f.clock.value = 1200;
  fail = true
  await assert.rejects(f.writer.maintain(), error => error === injected)
  await assert.rejects(put(f.writer, f.store, 5), code('UNAVAILABLE'))
  await f.close()
  const reopened = await setup(f.clock, f.directory)
  assert.equal(
    (await reopened.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items[0].value,
    4
  )
})

it('refuses maintenance intents that carry authored writes in memory and filesystem domains', async () => {
  const f = await setup(), memory = createMemoryStore({ domain: 'malformed' })
  const pos = { instance: 'test', epoch: 1, seq: 100 },
    node = { ...storedNode('/item'), $pos: pos }
  const commit = {
    pos,
    writerEpoch: f.lease.writerEpoch,
    writes: [{ path: node.$path, node }],
    record: maintenanceRecord(pos, 100, 0)
  }
  await assert.rejects(memory.commit(commit), code('INVALID'))
  await assert.rejects(f.store.commit(commit), code('INVALID'))
  assert.deepEqual((await f.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items, [])
  memory.close()
})
