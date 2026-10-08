import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { comparePositions, positionToRev, revToPosition } from '#kernel/position'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget, storedNode } from '#kernel/store/contract'
import { createInstanceStream } from '#kernel/stream'
import { createWriter, type PositionCounter, type PreparedCommit } from '#kernel/writer'
import type { DecisionRange, JournalCommit, JournalEntry, JournalRange, Position, ScanQuery, ScanRange, ScanResult, Store, StoredNode, StreamCursor, StreamEvent } from '#kernel/types'

function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function counter(initial?: Position) {
  let saved = initial, epoch = initial?.epoch ?? 0, fence = 0
  const api: PositionCounter = {
    async load() { return saved === undefined ? undefined : { ...saved } },
    async save(pos, writerEpoch) {
      if (writerEpoch < fence) throw new KernelError('CONFLICT', 'Stale counter writer')
      fence = writerEpoch; saved = { ...pos }
    },
    async freshEpoch(floor) { epoch = Math.max(epoch, floor) + 1; return epoch },
  }
  return api
}
const origin = (epoch = 1): StreamCursor => ({ pos: { instance: 'test', epoch, seq: 0 }, epochs: { a: 'a1', b: 'b1' } })
const prepared = (pos: Position, paths: readonly string[] = ['/item']): PreparedCommit => {
  const nodes = paths.map(path => ({ ...storedNode(path), $pos: pos }))
  return { writes: nodes.map(node => ({ path: node.$path, node })), record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel',
    entries: nodes.map((node): JournalEntry => ({ id: node.$id, path: node.$path, change: { t: 'create', after: node } })) } }
}
const stores = () => [createMemoryStore({ domain: 'a' }), createMemoryStore({ domain: 'b' })] as const
const open = (all: readonly Store[], persistent = false, saved = counter(), writerEpoch = 1) => createWriter({
  instance: 'test', root: all[0], writerEpoch, counter: saved, budget: scanBudget,
  domains: all.map(store => ({ store, epoch: `${store.domain}1`, persistent })),
})
async function event(iterator: AsyncIterator<StreamEvent>): Promise<StreamEvent> {
  const next = await iterator.next()
  assert.equal(next.done, false)
  assert.ok(next.value)
  return next.value
}

function delayedJournal(store: Store) {
  const copied = signal(), release = signal()
  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
    const range = query.range
    if ('journal' in range) {
      const result = await store.scan({ ...query, range })
      if (range.after !== undefined) {
        copied.resolve()
        await release.promise
      }
      return result
    }
    if ('decision' in range) return store.scan({ ...query, range })
    return store.scan({ ...query, range })
  }
  const wrapped: Store = { ...store, scan }
  return { store: wrapped, copied, release }
}

describe('position identity', () => {
  it('roundtrips revisions and orders epochs before sequences', () => {
    const position = { instance: 'id:"/unicode/\u00e9', epoch: 3, seq: 42 }
    assert.deepEqual(revToPosition(positionToRev(position)), position)
    assert.equal(comparePositions(position, position), 0)
    assert.equal(comparePositions(position, { ...position, seq: 43 }), -1)
    assert.equal(comparePositions(position, { ...position, epoch: 2, seq: 999 }), 1)
    assert.throws(() => comparePositions(position, { ...position, instance: 'other' }),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
  })
  it('rejects malformed revision tuples without coercing their fields', () => {
    for (const value of [[], ['', 1, 2], ['test', '1', 2], ['test', 1, -1], ['test', 1.5, 1]]) {
      assert.throws(() => revToPosition(JSON.stringify(value)), (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
    }
  })
})

describe('instance writer', { timeout: 10_000 }, () => {
  it('denies queued prepares, pending reads and a prepared independent write after publication fails', async () => {
    const [root, other] = stores(), entered = signal(), release = signal(), otherEntered = signal(), otherRelease = signal()
    const failure = new KernelError('INVALID', 'Accepted publication failed')
    const writer = await createWriter({ instance: 'test', root, writerEpoch: 1, counter: counter(), budget: scanBudget,
      domains: [root, other].map(store => ({ store, epoch: '1', persistent: false })),
      applied(_domain, commit) { if (commit.writes.length !== 0) throw failure } })
    const first = writer.commit(root, [], async pos => { entered.resolve(); await release.promise; return prepared(pos, ['/durable']) })
    const deniedFirst = assert.rejects(first, error => error === failure)
    await entered.promise
    const independent = writer.commit(other, [], async pos => { otherEntered.resolve(); await otherRelease.promise; return prepared(pos, ['/independent']) })
    const deniedIndependent = assert.rejects(independent, error => error === failure)
    await otherEntered.promise
    let ran = false, read = false
    const queued = writer.commit(root, [], pos => { ran = true; return prepared(pos, ['/queued']) })
    const deniedQueued = assert.rejects(queued, error => error === failure)
    const pending = writer.read([root.domain], async () => { read = true; return 'cached-result' })
    const deniedRead = assert.rejects(pending, error => error === failure)
    release.resolve()
    await deniedFirst
    otherRelease.resolve()
    await Promise.all([deniedIndependent, deniedQueued, deniedRead])
    assert.equal(ran, false)
    assert.equal(read, false)
    assert.deepEqual((await root.scan({ range: { node: '/queued' }, budget: scanBudget() })).items, [])
    assert.deepEqual((await other.scan({ range: { node: '/independent' }, budget: scanBudget() })).items, [])
    assert.equal((await root.scan({ range: { node: '/durable' }, budget: scanBudget() })).items.length, 1)
  })

  it('holds domain reads through completion without issuing positions and releases rejected reads', async () => {
    const [root] = stores(), writer = await open([root]), entered = signal(), release = signal()
    const before = writer.position
    let preparedNext = false
    const reading = writer.read([root.domain], async () => {
      entered.resolve()
      await release.promise
      assert.equal(preparedNext, false)
      return 'snapshot'
    })
    await entered.promise
    assert.deepEqual(writer.position, before)
    const writing = writer.commit(root, [], pos => { preparedNext = true; return prepared(pos, ['/after-read']) })
    release.resolve()
    assert.equal(await reading, 'snapshot')
    await writing
    assert.equal(preparedNext, true)
    const failure = new KernelError('INVALID', 'Read callback failed')
    await assert.rejects(writer.read([root.domain], async () => { throw failure }), error => error === failure)
    const next = await writer.commit(root, [], pos => prepared(pos, ['/after-rejected-read']))
    assert.equal(next.seq, before.seq + 2)
    await assert.rejects(writer.read(['unknown'], async () => 'unreachable'),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
  })

  it('starts domain reads after the preceding writer publishes and identifies same-domain target Stores', async () => {
    const root = createMemoryStore({ domain: 'shared' }), other = createMemoryStore({ domain: 'shared' })
    const published = new Map<Store, string[]>(), entered = signal(), release = signal()
    const writer = await createWriter({ instance: 'test', root, writerEpoch: 1, counter: counter(), budget: scanBudget,
      domains: [root, other].map(store => ({ store, epoch: 'shared1', persistent: false })),
      applied(domain, _commit, images, store) {
        assert.equal(domain, root.domain)
        const paths = published.get(store) ?? []
        paths.push(...images.map(image => image.path))
        published.set(store, paths)
      } })
    const writing = writer.commit(root, [], async pos => { entered.resolve(); await release.promise; return prepared(pos, ['/root']) })
    await entered.promise
    const reading = writer.read([root.domain], async () => { assert.deepEqual(published.get(root), ['/root']); return writer.position })
    release.resolve()
    const pos = await writing
    assert.deepEqual(await reading, pos)
    await writer.commit(other, [], pos => prepared(pos, ['/other']))
    assert.deepEqual(published.get(root), ['/root'])
    assert.deepEqual(published.get(other), ['/other'])
  })

  it('publishes accepted images before observers and queued same-domain preparations', async () => {
    const store = createMemoryStore({ domain: 'memory' }), accepted = new Map<string, StoredNode | null>()
    const writer = await createWriter({ instance: 'test', root: store, writerEpoch: 1, counter: counter(), budget: scanBudget,
      domains: [{ store, epoch: 'memory1', persistent: false }],
      applied(domain, commit, images) {
        assert.equal(domain, store.domain)
        for (const image of images) {
          assert.ok(Object.isFrozen(image))
          if (image.node !== null) assert.ok(Object.isFrozen(image.node))
          assert.deepEqual(image.pos, commit.pos)
          accepted.set(image.path, image.node)
        }
      },
    })
    const iterator = writer.stream.follow(writer.stream.cursor())[Symbol.asyncIterator]()
    const observed = iterator.next().then(frame => {
      assert.equal(frame.done, false)
      assert.ok(accepted.get('/first'))
      return frame
    })
    const started = signal(), release = signal()
    const first = writer.commit(store, [], async pos => {
      started.resolve()
      await release.promise
      return prepared(pos, ['/first'])
    })
    await started.promise
    const second = writer.commit(store, [], pos => {
      assert.ok(accepted.get('/first'))
      return prepared(pos, ['/second'])
    })
    release.resolve()
    const positions = await Promise.all([first, second])
    await observed
    assert.deepEqual(accepted.get('/second')?.$pos, positions[1])
    assert.equal(comparePositions(positions[0], positions[1]), -1)
    await iterator.return?.()
  })

  it('stops serving writes when accepted-image publication fails after a durable commit', async () => {
    const store = createMemoryStore({ domain: 'memory' }), failure = new KernelError('INVALID', 'Injected publication failure')
    const writer = await createWriter({ instance: 'test', root: store, writerEpoch: 1, counter: counter(), budget: scanBudget,
      domains: [{ store, epoch: 'memory1', persistent: false }],
      applied(_domain, commit) { if (commit.writes.length !== 0) throw failure },
    })
    await assert.rejects(writer.commit(store, [], pos => prepared(pos, ['/durable'])), error => error === failure)
    const stored = (await store.scan({ range: { node: '/durable' }, budget: scanBudget() })).items
    assert.equal(stored.length, 1)
    let ran = false
    await assert.rejects(writer.commit(store, [], pos => { ran = true; return prepared(pos, ['/later']) }), error => error === failure)
    assert.equal(ran, false)
    assert.equal((await store.scan({ range: { node: '/later' }, budget: scanBudget() })).items.length, 0)
  })

  it('uses one position for every write and its journal record', async () => {
    const [a] = stores(), writer = await open([a])
    const pos = await writer.commit(a, [], pos => prepared(pos, ['/x', '/y']))
    assert.deepEqual((await a.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$pos), [pos, pos])
    const record = (await a.scan({ range: { journal: '/' }, budget: scanBudget() })).items.at(-1)!
    assert.deepEqual(record.pos, pos)
    for (const entry of record.entries) {
      assert.ok(entry.change.t === 'create')
      assert.deepEqual(entry.change.after.$pos, pos)
    }
  })

  it('applies same-domain commits in position order', async () => {
    const [a] = stores(), writer = await open([a]), entered = signal(), release = signal()
    const base = writer.position.seq
    const order: number[] = []
    const first = writer.commit(a, [], async pos => { entered.resolve(); await release.promise; order.push(pos.seq); return prepared(pos) })
    await entered.promise
    const second = writer.commit(a, [], pos => { order.push(pos.seq); return prepared(pos) })
    release.resolve()
    await Promise.all([first, second])
    assert.deepEqual(order, [base + 1, base + 2])
  })

  it('applies independent domains in parallel but publishes them in position order', async () => {
    const [a, b] = stores(), writer = await open([a, b]), entered = signal(), release = signal(), secondApplied = signal()
    const base = writer.position.seq
    const iterator = writer.stream.follow(writer.stream.cursor())[Symbol.asyncIterator]()
    const published = event(iterator)
    const order: number[] = []
    const first = writer.commit(a, [], async pos => { entered.resolve(); await release.promise; order.push(pos.seq); return prepared(pos) })
    await entered.promise
    const second = writer.commit(b, [], pos => { order.push(pos.seq); secondApplied.resolve(); return prepared(pos, ['/b-item']) })
    await secondApplied.promise
    assert.deepEqual(order, [base + 2])
    release.resolve()
    await Promise.all([first, second])
    const one = await published, two = await event(iterator)
    assert.equal(one.t, 'commit'); assert.equal(two.t, 'commit')
    if (one.t === 'commit' && two.t === 'commit') assert.deepEqual([one.record.pos.seq, two.record.pos.seq], [base + 1, base + 2])
    await iterator.return?.()
  })

  it('waits for previous writes in every read domain, including rights inputs', async () => {
    const [a, b] = stores(), writer = await open([a, b]), entered = signal(), release = signal()
    let state = 'before'
    const first = writer.commit(a, [], async pos => { entered.resolve(); await release.promise; state = 'after'; return prepared(pos) })
    await entered.promise
    const second = writer.commit(b, ['a'], pos => { assert.equal(state, 'after'); return prepared(pos, ['/b-item']) })
    release.resolve()
    await Promise.all([first, second])
    assert.equal(state, 'after')
  })

  it('keeps a later writer out of an earlier commit read domain', async () => {
    const [a, b] = stores(), writer = await open([a, b]), entered = signal(), release = signal()
    let state = 'before'
    const first = writer.commit(a, ['b'], async pos => { entered.resolve(); await release.promise; assert.equal(state, 'before'); return prepared(pos) })
    await entered.promise
    const second = writer.commit(b, [], pos => { state = 'after'; return prepared(pos, ['/b-item']) })
    release.resolve()
    await Promise.all([first, second])
    assert.equal(state, 'after')
  })

  it('publishes a failure as a gap and lets the next same-domain commit proceed', async () => {
    const [a] = stores(), writer = await open([a]), error = new Error('Rejected commit')
    const base = writer.position
    const iterator = writer.stream.follow(writer.stream.cursor())[Symbol.asyncIterator]()
    const gap = event(iterator)
    await assert.rejects(() => writer.commit(a, [], () => { throw error }), (actual: unknown) => actual === error)
    assert.deepEqual(await gap, { t: 'gap', pos: { ...base, seq: base.seq + 1 } })
    const next = await writer.commit(a, [], pos => prepared(pos))
    assert.equal(next.seq, base.seq + 2)
    assert.equal((await event(iterator)).t, 'commit')
    await iterator.return?.()
  })

  it('passes its fencing epoch to the Store', async () => {
    const [a] = stores()
    const current = await open([a], false, counter(), 2)
    await current.commit(a, [], pos => prepared(pos))
    await assert.rejects(() => open([a], false, counter(), 1),
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT')
    assert.deepEqual((await a.scan({ range: { node: '/stale' }, budget: scanBudget() })).items, [])
  })

  it('resumes a durable counter over persistent journals, including an issued gap', async () => {
    const [a] = stores(), saved = counter(), first = await open([a], true, saved)
    await first.commit(a, [], pos => prepared(pos))
    await assert.rejects(() => first.commit(a, [], () => { throw new Error('gap') }), Error)
    const base = first.position
    const restarted = await open([a], true, saved)
    const next = await restarted.commit(a, [], pos => prepared(pos))
    assert.deepEqual(next, { ...base, seq: base.seq + 2 })
  })

  it('opens a fresh epoch when a restored counter lags the persistent journal', async () => {
    const [a] = stores(), first = await open([a], true)
    await first.commit(a, [], pos => prepared(pos))
    const restored = await open([a], true, counter({ instance: 'test', epoch: 1, seq: 0 }))
    assert.deepEqual(await restored.commit(a, [], pos => prepared(pos)), { instance: 'test', epoch: 2, seq: 2 })
  })

  it('opens a new epoch after loss of a memory-only counter', async () => {
    const [a] = stores()
    let durableEpoch = 0
    const memoryCounter = (): PositionCounter => ({ async load() { return undefined }, async save() {}, async freshEpoch() { return ++durableEpoch } })
    const first = await open([a], false, memoryCounter())
    await first.commit(a, [], pos => prepared(pos))
    const fresh = createMemoryStore({ domain: 'a' })
    const restarted = await open([fresh], false, memoryCounter())
    assert.deepEqual(await restarted.commit(fresh, [], pos => prepared(pos)), { instance: 'test', epoch: 2, seq: 2 })
  })

  it('never issues a position whose durable counter reservation failed', async () => {
    const [a] = stores(), saved = counter(), error = new Error('Counter write failed')
    let fail = false
    const fenced: PositionCounter = { ...saved, async save(pos, epoch) {
      if (fail) throw error
      await saved.save(pos, epoch)
    } }
    const writer = await open([a], false, fenced)
    const base = writer.position.seq
    fail = true
    await assert.rejects(() => writer.commit(a, [], pos => prepared(pos)), (actual: unknown) => actual === error)
    assert.equal(writer.position.seq, base)
    assert.equal(writer.stream.cursor().pos.seq, base)
    assert.deepEqual((await a.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
    fail = false
    assert.equal((await writer.commit(a, [], pos => prepared(pos))).seq, base + 1)
  })

  it('fences counter reservations by an old writer after failover', async () => {
    const [a] = stores(), saved = counter(), old = await open([a], true, saved, 1)
    const base = old.position.seq
    const current = await open([a], true, saved, 2)
    await current.commit(a, [], pos => prepared(pos))
    await assert.rejects(() => old.commit(a, [], pos => prepared(pos, ['/stale'])),
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT')
    assert.equal(old.position.seq, base)
    assert.deepEqual((await a.scan({ range: { node: '/stale' }, budget: scanBudget() })).items, [])
  })

  it('fences an already-reserved old write before a new writer serves another domain', async () => {
    const [a, b] = stores(), saved = counter(), old = await open([a, b], true, saved, 1)
    const entered = signal(), release = signal()
    const pending = old.commit(b, [], async pos => { entered.resolve(); await release.promise; return prepared(pos, ['/stale']) })
    const refused = assert.rejects(pending, (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT')
    await entered.promise
    const current = await open([a, b], true, saved, 2)
    await current.commit(a, ['b'], pos => prepared(pos))
    release.resolve()
    await refused
    assert.deepEqual((await b.scan({ range: { node: '/stale' }, budget: scanBudget() })).items, [])
  })

  it('rejects an unregistered Store even when its domain name matches', async () => {
    const [a] = stores(), writer = await open([a])
    const base = writer.position.seq
    await assert.rejects(() => writer.commit(createMemoryStore({ domain: 'a' }), [], pos => prepared(pos)),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
    assert.equal(writer.position.seq, base)
  })
})

describe('instance stream', { timeout: 10_000 }, () => {
  it('deduplicates the same journal record exposed by stores in one domain', async () => {
    const a = createMemoryStore({ domain: 'a' }), other = createMemoryStore({ domain: 'a' })
    const pos = { ...origin().pos, seq: 1 }, data = prepared(pos)
    await Promise.all([a.commit({ ...data, pos, writerEpoch: 1 }), other.commit({ ...data, pos, writerEpoch: 1 })])
    const stream = createInstanceStream({ position: pos, domains: [a, other].map(store => ({ store, epoch: 'a1', persistent: true })), budget: scanBudget })
    const iterator = stream.follow(origin())[Symbol.asyncIterator]()
    assert.deepEqual(await event(iterator), { t: 'commit', domain: 'a', record: data.record })
    const pending = iterator.next()
    stream.publish({ t: 'gap', pos: { ...pos, seq: 2 } })
    assert.deepEqual((await pending).value, { t: 'gap', pos: { ...pos, seq: 2 } })
    await iterator.return?.()
  })

  it('rejects conflicting journal records sharing one instance position', async () => {
    for (const domain of ['a', 'b']) {
      const a = createMemoryStore({ domain: 'a' }), other = createMemoryStore({ domain })
      const pos = { ...origin().pos, seq: 1 }
      await a.commit({ ...prepared(pos, ['/x']), pos, writerEpoch: 1 })
      await other.commit({ ...prepared(pos, ['/y']), pos, writerEpoch: 1 })
      const stream = createInstanceStream({ position: pos, domains: [a, other].map(store => ({ store, epoch: `${store.domain}1`, persistent: true })), budget: scanBudget })
      const iterator = stream.follow(origin())[Symbol.asyncIterator]()
      await assert.rejects(iterator.next(), (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
      assert.equal((await iterator.return?.())?.done, true)
    }
  })

  it('catches up from the journals and then continues live without duplicates', async () => {
    const [a, b] = stores(), writer = await open([a, b])
    const from = writer.stream.cursor()
    await writer.commit(a, [], pos => prepared(pos))
    await writer.commit(b, [], pos => prepared(pos, ['/b-item']))
    const iterator = writer.stream.follow(from)[Symbol.asyncIterator]()
    const first = await event(iterator), second = await event(iterator)
    assert.equal(first.t, 'commit'); assert.equal(second.t, 'commit')
    if (first.t === 'commit' && second.t === 'commit') assert.deepEqual([first.record.pos.seq, second.record.pos.seq], [from.pos.seq + 1, from.pos.seq + 2])
    await writer.commit(a, [], pos => prepared(pos))
    const third = await event(iterator)
    assert.equal(third.t, 'commit')
    if (third.t === 'commit') assert.equal(third.record.pos.seq, from.pos.seq + 3)
    await iterator.return?.()
  })

  it('resets only a domain present in the cursor whose continuity changed', async () => {
    const [a, b] = stores()
    const stream = createInstanceStream({ position: origin().pos, domains: [
      { store: a, epoch: 'new-a', persistent: false }, { store: b, epoch: 'b1', persistent: true },
    ], budget: scanBudget })
    const iterator = stream.follow(origin())[Symbol.asyncIterator]()
    assert.deepEqual(await event(iterator), { t: 'reset', domain: 'a', epoch: 'new-a' })
    await iterator.return?.()
    const other = stream.follow({ ...origin(), epochs: { b: 'b1' } })[Symbol.asyncIterator]()
    const pending = other.next()
    stream.publish({ t: 'gap', pos: { ...origin().pos, seq: 1 } })
    assert.deepEqual((await pending).value, { t: 'gap', pos: { ...origin().pos, seq: 1 } })
    await other.return?.()
  })

  it('cancels an idle pending next without requiring another publication', async () => {
    const [a] = stores(), writer = await open([a])
    const iterator = writer.stream.follow(writer.stream.cursor())[Symbol.asyncIterator]()
    const pending = iterator.next()
    const returned = await iterator.return?.()
    assert.equal(returned?.done, true)
    assert.equal((await pending).done, true)
  })

  it('keeps a publication that arrives after the journal snapshot was copied', async () => {
    const [a, b] = stores(), delayed = delayedJournal(a), writer = await open([delayed.store, b])
    const from = writer.stream.cursor()
    const iterator = writer.stream.follow(from)[Symbol.asyncIterator]()
    const first = event(iterator)
    await delayed.copied.promise
    await writer.commit(delayed.store, [], pos => prepared(pos))
    delayed.release.resolve()
    const one = await first
    assert.equal(one.t, 'commit')
    if (one.t === 'commit') assert.equal(one.record.pos.seq, from.pos.seq + 1)
    await writer.commit(b, [], pos => prepared(pos, ['/b-item']))
    const two = await event(iterator)
    assert.equal(two.t, 'commit')
    if (two.t === 'commit') assert.equal(two.record.pos.seq, from.pos.seq + 2)
    await iterator.return?.()
  })

  it('refuses a follower whose bounded live queue overflows during catch-up', async () => {
    for (const limits of [{ bufferedEvents: 1 }, { bufferedBytes: 1 }]) {
      const [a] = stores(), delayed = delayedJournal(a)
      const stream = createInstanceStream({ position: origin().pos,
        domains: [{ store: delayed.store, epoch: 'a1', persistent: false }], budget: scanBudget, ...limits })
      const iterator = stream.follow(origin())[Symbol.asyncIterator]()
      const pending = iterator.next()
      const refusal = assert.rejects(pending, (error: unknown) => error instanceof KernelError && error.code === 'BUDGET')
      await delayed.copied.promise
      stream.publish({ t: 'gap', pos: { ...origin().pos, seq: 1 } })
      stream.publish({ t: 'gap', pos: { ...origin().pos, seq: 2 } })
      delayed.release.resolve()
      await refusal
      assert.equal((await iterator.return?.())?.done, true)
    }
  })
})
