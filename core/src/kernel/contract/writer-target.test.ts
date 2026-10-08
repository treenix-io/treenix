import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { KernelError } from '#errors'
import type { MutationIdentity } from '#kernel/idempotency'
import { openPersistentWriter } from '#kernel/persistence'
import { positionToRev } from '#kernel/position'
import { scanBudget, storedNode } from '#kernel/store/contract'
import { createFsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { createWriter, type PreparedCommit, type StoreTargetRegistration, type TargetLifecycle } from '#kernel/writer'
import type { DecisionRange, JournalCommit, JournalRange, OpenedStoreMountTarget, Position, PositionCounter, ScanQuery, ScanRange, ScanResult, Store, StoredNode } from '#kernel/types'

/** Coordinate actual lifecycle boundaries without timing assumptions. */
function barrier() {
  let release: () => void = () => {}
  const reached = new Promise<void>(resolve => { release = resolve })
  return { reached, release }
}

/** Retain genuine issued positions and require the root's acquired counter token. */
function counter(token: number): PositionCounter {
  let position: Position | undefined, epoch = 0
  return {
    async load() { return position },
    async save(next, writerEpoch) { assert.equal(writerEpoch, token); position = next },
    async freshEpoch(floor) { epoch = Math.max(epoch, floor) + 1; return epoch },
  }
}

/** Create an owned empty decision inventory with a separately acquired target fence. */
function target(domain: string, writerEpoch: number) {
  const store = createMemoryStore({ domain })
  let closes = 0
  const opened: OpenedStoreMountTarget = {
    kind: 'store', store,
    resources: { epoch: `${domain}-continuity`, persistent: false, writerEpoch, decisionHistory: 'fresh' },
    async close() { closes++; store.close() },
  }
  const registration: StoreTargetRegistration = { key: domain, revision: 'declaration', target: opened }
  return { opened, registration, get closes() { return closes } }
}

/** Prepare one concrete Store write with its canonical journal image. */
function prepared(pos: Position, path = '/item'): PreparedCommit {
  const node = { ...storedNode(path), $pos: pos }
  return { writes: [{ path: node.$path, node }], transitions: [{ id: node.$id, before: null, after: node }],
    record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel',
      entries: [{ id: node.$id, path: node.$path, change: { t: 'create', after: node } }] } }
}

/** Open a root-only Writer while keeping target publication observable. */
async function writer(root: Store, token = 1, lifecycle: TargetLifecycle = { validate() {}, publish() {} }) {
  return createWriter({ instance: 'targets', root, writerEpoch: token, counter: counter(token), budget: scanBudget,
    domains: [{ store: root, epoch: 'root-continuity', persistent: false }], targetLifecycle: lifecycle })
}

/** Hold actual replay or decision IO while retirement changes its ownership inventory. */
function heldScan(store: Store, kind: 'journal' | 'decision') {
  const entered = barrier(), resume = barrier()
  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
    const range = query.range
    if ('journal' in range) {
      if (kind === 'journal' && range.after !== undefined) { entered.release(); await resume.reached }
      return store.scan({ ...query, range })
    }
    if ('decision' in range) {
      if (kind === 'decision') { entered.release(); await resume.reached }
      return store.scan({ ...query, range })
    }
    return store.scan({ ...query, range })
  }
  return { store: { ...store, scan }, entered, resume }
}

describe('owned writer targets', { timeout: 10_000 }, () => {
  for (const [rootToken, targetToken] of [[1, 3], [7, 1], [0, 0]]) it(`uses independent root ${rootToken} and target ${targetToken} authority`, async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', targetToken)
    const commits: number[] = []
    const actual = mounted.opened.store
    const observed: Store = { ...actual, async commit(input) { commits.push(input.writerEpoch); return actual.commit(input) } }
    const registration = { ...mounted.registration, target: { ...mounted.opened, store: observed } }
    const active = await writer(root, rootToken)
    const intake = active.intake.epoch
    await active.activateTarget(registration)
    assert.equal(active.intake.epoch, intake)
    await active.commit(observed, ['root'], prepared)
    assert.deepEqual(commits, [targetToken, targetToken])
    assert.equal((await actual.scan({ range: { node: '/item' }, budget: scanBudget() })).items.length, 1)
    await active.retireTarget(registration.key, registration.revision)
    assert.notEqual(active.intake.epoch, intake)
    assert.equal(mounted.closes, 1)
    await assert.rejects(active.commit(observed, [], prepared), (error: unknown) => error instanceof KernelError)
  })

  it('keeps activation off-route until its fence and durable intake complete', async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 3)
    const entered = barrier(), resume = barrier()
    const actual = mounted.opened.store
    const held: Store = { ...actual, async commit(input) { entered.release(); await resume.reached; return actual.commit(input) } }
    const registration = { ...mounted.registration, target: { ...mounted.opened, store: held } }
    let published = false
    const active = await writer(root, 1, { validate() {}, publish(event) {
      published = true
      if (event.kind === 'activate') assert.ok(active.intake.domains.mounted)
    } })
    const activation = active.activateTarget(registration)
    await entered.reached
    assert.equal(published, false)
    assert.equal(active.stream.cursor().epochs.mounted, undefined)
    await assert.rejects(active.commit(held, [], prepared), (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
    const rootCommit = active.commit(root, [], prepared)
    resume.release()
    const pos = await activation
    assert.equal(published, true)
    assert.ok((await rootCommit).seq > pos.seq)
    await active.retireTarget(registration.key, registration.revision)
  })

  it('drains admitted readers and rejects prepared effects pinned to a retired generation', async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 2)
    const active = await writer(root)
    await active.activateTarget(mounted.registration)
    const entered = barrier(), resume = barrier()
    const operation = active.commit(mounted.opened.store, [], async pos => {
      entered.release(); await resume.reached; return prepared(pos)
    })
    await entered.reached
    const retirement = active.retireTarget(mounted.registration.key, mounted.registration.revision)
    assert.equal(mounted.closes, 0)
    resume.release()
    await assert.rejects(operation, (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
    await retirement
    assert.equal(mounted.closes, 1)
    await assert.rejects(mounted.opened.store.scan({ range: { node: '/item' }, budget: scanBudget() }),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
  })

  it('resets a removed cursor domain and preserves the root continuity', async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 2)
    const active = await writer(root)
    await active.activateTarget(mounted.registration)
    const before = active.stream.cursor()
    await active.retireTarget(mounted.registration.key, mounted.registration.revision)
    const replay = active.stream.follow(before)[Symbol.asyncIterator]()
    const reset = await replay.next()
    assert.equal(reset.done, false)
    assert.equal(reset.value.t, 'reset')
    if (reset.value.t !== 'reset') throw new Error('Expected continuity reset')
    assert.equal(reset.value.domain, 'mounted')
    assert.equal(active.stream.cursor().epochs.root, before.epochs.root)
    assert.equal(active.stream.cursor().epochs.mounted, undefined)
    await replay.return?.()
  })

  it('latches a durable publication failure before queued effects', async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 2)
    const failure = new Error('Publication failure')
    const active = await writer(root, 1, { validate() {}, publish() { throw failure } })
    const activation = active.activateTarget(mounted.registration)
    const queued = active.commit(root, [], prepared)
    await assert.rejects(activation, error => error === failure)
    await assert.rejects(queued, error => error === failure)
    assert.equal((await root.scan({ range: { node: '/item' }, budget: scanBudget() })).items.length, 0)
    await active.closeTargets()
    await active.closeTargets()
    assert.equal(mounted.closes, 1)
  })

  it('waits for target readers before cleanup and preserves borrowed root IO', async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 2)
    const active = await writer(root)
    await active.activateTarget(mounted.registration)
    const entered = barrier(), resume = barrier()
    const reading = active.read(['mounted'], async () => {
      entered.release(); await resume.reached
      return mounted.opened.store.scan({ range: { node: '/item' }, budget: scanBudget() })
    })
    await entered.reached
    const closing = active.closeTargets()
    assert.equal(mounted.closes, 0)
    await assert.rejects(active.read(['root'], async () => 1),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
    resume.release()
    assert.equal((await reading).items.length, 0)
    await closing
    assert.equal(mounted.closes, 1)
    assert.equal((await root.scan({ range: { node: '/' }, budget: scanBudget() })).items.length, 0)
  })

  it('cleans a fenced off-route target and blocks later effects when root intake fails', async () => {
    const actual = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 2)
    let fail = false
    const root: Store = { ...actual, async commit(input) {
      if (fail) throw new KernelError('UNAVAILABLE', 'Root is temporarily unavailable')
      return actual.commit(input)
    } }
    let published = 0
    const active = await writer(root, 1, { validate() {}, publish() { published++ } })
    const intake = active.intake
    fail = true
    await assert.rejects(active.activateTarget(mounted.registration),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
    assert.equal(mounted.closes, 1)
    assert.equal(published, 0)
    assert.deepEqual(active.intake, intake)
    assert.equal(active.stream.cursor().epochs.mounted, undefined)
    fail = false
    await assert.rejects(active.commit(root, [], prepared),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
    assert.equal((await actual.scan({ range: { node: '/item' }, budget: scanBudget() })).items.length, 0)
    await active.closeTargets()
  })

  for (const operation of ['replace', 'retire'] as const) it(`blocks later effects after a durable root intake failure during ${operation}`, async () => {
    const base = resolve('../../temp/writer-target-fs')
    await mkdir(base, { recursive: true })
    const directory = await mkdtemp(join(base, 'durable-intake-'))
    const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'targets' })
    const failure = new Error('Filesystem apply failed after durable journal acceptance')
    let fault = false
    const root = await createFsStore({ directory, lease, checkpoint(stage) {
      if (fault && stage === 'recordSynced') { fault = false; throw failure }
    } })
    const active = await createWriter({ instance: 'targets', root, counter: lease, writerEpoch: lease.writerEpoch,
      domains: [{ store: root, epoch: lease.epoch, persistent: true }], budget: scanBudget,
      targetLifecycle: { validate() {}, publish() {} } })
    const previous = target('previous', 1), replacement = target('replacement', 1)
    try {
      await active.activateTarget(previous.registration)
      const journal = join(directory, '.treenix', 'journal.log')
      const before = (await readFile(journal)).length
      const intake = active.intake
      fault = true
      const changing = operation === 'replace'
        ? active.activateTarget({ ...replacement.registration, key: previous.registration.key })
        : active.retireTarget(previous.registration.key, previous.registration.revision)
      await assert.rejects(changing, error => error === failure)
      assert.ok((await readFile(journal)).length > before)
      assert.deepEqual(active.intake, intake)
      assert.equal(previous.closes, 0)
      assert.equal(replacement.closes, operation === 'replace' ? 1 : 0)
      await assert.rejects(active.commit(previous.opened.store, [root.domain], prepared), error => error === failure)
      assert.equal((await previous.opened.store.scan({ range: { node: '/item' }, budget: scanBudget() })).items.length, 0)
      await active.closeTargets()
      assert.equal(previous.closes, 1)
    } finally {
      await active.closeTargets()
      if (operation === 'retire') await replacement.opened.close()
      await root.close(); await lease.close()
    }
  })

  it('replaces exact Store ownership and resets that domain without changing the root epoch', async () => {
    const root = createMemoryStore({ domain: 'root' }), first = target('mounted', 2), second = target('mounted', 4)
    const active = await writer(root)
    await active.activateTarget(first.registration)
    const before = active.stream.cursor(), intake = active.intake.epoch
    const replacement = { ...second.registration, revision: 'new-declaration', target: {
      ...second.opened, resources: { ...second.opened.resources, epoch: 'replacement-continuity' },
    } }
    await active.activateTarget(replacement)
    assert.equal(first.closes, 1)
    assert.notEqual(active.intake.epoch, intake)
    const replay = active.stream.follow(before)[Symbol.asyncIterator]()
    const event = await replay.next()
    assert.deepEqual(event.value, { t: 'reset', domain: 'mounted', epoch: 'replacement-continuity' })
    assert.equal(active.stream.cursor().epochs.root, before.epochs.root)
    await replay.return?.()
    await assert.rejects(active.commit(first.opened.store, [], prepared),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
    await active.commit(replacement.target.store, [], prepared)
    await active.closeTargets()
    assert.equal(second.closes, 1)
  })

  for (const kind of ['journal', 'decision'] as const) it(`drains captured ${kind} IO before retiring its Store`, async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 2)
    const held = heldScan(mounted.opened.store, kind), published = barrier()
    const registration = { ...mounted.registration, target: { ...mounted.opened, store: held.store } }
    const active = await writer(root, 1, { validate() {}, publish(event) { if (event.kind === 'retire') published.release() } })
    await active.activateTarget(registration)
    const stream = active.stream.follow(active.stream.cursor())[Symbol.asyncIterator]()
    const operation = kind === 'journal' ? stream.next() : active.replay({
      actor: { principal: 'u:one', claims: [], scope: ['/'] }, request: {},
      opId: { epoch: active.intake.epoch, time: Date.now(), nonce: 'lookup' },
    })
    await held.entered.reached
    const retiring = active.retireTarget(registration.key, registration.revision)
    await published.reached
    assert.equal(mounted.closes, 0)
    held.resume.release()
    await operation
    await retiring
    assert.equal(mounted.closes, 1)
    await stream.return?.()
  })

  it('replays surviving decisions after retirement and refuses absent old-epoch effects', async () => {
    const root = createMemoryStore({ domain: 'root' }), mounted = target('mounted', 2)
    const active = await writer(root)
    await active.activateTarget(mounted.registration)
    const identity = (nonce: string): MutationIdentity => ({ actor: { principal: 'u:one', claims: [], scope: ['/'] }, request: { nonce },
      opId: { epoch: active.intake.epoch, time: Date.now(), nonce } })
    const surviving = identity('surviving'), lost = identity('lost')
    const mutation = (pos: Position, path: string): PreparedCommit => {
      const input = prepared(pos, path)
      return { ...input, record: { ...input.record, caller: 'u:one' } }
    }
    const rootOutcome = await active.mutate(surviving, span => span.finish(root, [], pos => mutation(pos, '/root-item')))
    await active.mutate(lost, span => span.finish(mounted.opened.store, [], pos => mutation(pos, '/mounted-item')))
    await active.retireTarget(mounted.registration.key, mounted.registration.revision)
    assert.deepEqual(await active.replay(surviving), rootOutcome)
    let executed = false
    await assert.rejects(active.mutate(lost, async span => {
      executed = true
      return span.finish(root, [], prepared)
    }), (error: unknown) => error instanceof KernelError && error.code === 'UNKNOWN_OUTCOME')
    assert.equal(executed, false)
    await active.closeTargets()
  })

  it('advances the genuine root floor before an unequal persistent target fence', async () => {
    const base = resolve('../../temp/writer-target-fs')
    await mkdir(base, { recursive: true })
    const directory = await mkdtemp(join(base, 'leases-'))
    const rootPath = join(directory, 'root'), targetPath = join(directory, 'target')
    const rootLease = await openPersistentWriter({ directory: join(rootPath, '.treenix'), instance: 'targets' })
    let targetLease = await openPersistentWriter({ directory: join(targetPath, '.treenix'), instance: 'targets' })
    await targetLease.close()
    targetLease = await openPersistentWriter({ directory: join(targetPath, '.treenix'), instance: 'targets' })
    const root = await createFsStore({ directory: rootPath, lease: rootLease })
    const store = await createFsStore({ directory: targetPath, lease: targetLease })
    let closed = false
    try {
      assert.notEqual(rootLease.writerEpoch, targetLease.writerEpoch)
      const last = { instance: 'targets', epoch: 12, seq: 90 }
      await store.commit({ pos: last, writerEpoch: targetLease.writerEpoch, writes: [],
        record: { pos: last, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } })
      const active = await createWriter({ instance: 'targets', root, writerEpoch: rootLease.writerEpoch, counter: rootLease,
        domains: [{ store: root, epoch: rootLease.epoch, persistent: true }], budget: scanBudget,
        targetLifecycle: { validate() {}, publish() {} } })
      const opened: OpenedStoreMountTarget = { kind: 'store', store,
        resources: { epoch: targetLease.epoch, persistent: true, writerEpoch: targetLease.writerEpoch, decisionHistory: 'retained' },
        async close() { await store.close(); await targetLease.close(); closed = true } }
      const registration = { key: 'fs', revision: positionToRev(last), target: opened }
      const pos = await active.activateTarget(registration)
      assert.ok(pos.epoch > last.epoch)
      await active.commit(store, [], prepared)
      assert.equal((await rootLease.load())?.epoch, pos.epoch)
      await active.retireTarget(registration.key, registration.revision)
      assert.equal(closed, true)
      const reacquired = await openPersistentWriter({ directory: join(targetPath, '.treenix'), instance: 'targets' })
      await reacquired.close()
    } finally {
      if (!closed) { await store.close(); await targetLease.close() }
      await root.close(); await rootLease.close()
    }
  })
})
