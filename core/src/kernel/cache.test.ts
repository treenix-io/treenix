import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createProcessCache } from '#kernel/cache'
import { createMemoryStore } from '#kernel/store/memory'
import { position, scanBudget, storeCommit, storedNode } from '#kernel/store/contract'
import type { DecisionRange, JournalCommit, JournalRange, ScanQuery, ScanRange, ScanResult, Store, StoreCommit, StoredNode } from '#kernel/types'
import { createWriter } from '#kernel/writer'

const refused = (code: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === code
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function delayed(store: Store) {
  const entered = signal(), release = signal()
  const originalScan = store.scan
  let scans = 0
  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
    const range = query.range
    if ('journal' in range || 'decision' in range) return originalScan({ ...query, range })
    const result = await originalScan({ ...query, range })
    scans++; entered.resolve()
    await release.promise
    return result
  }
  store.scan = scan
  return { store, entered, release, get scans() { return scans } }
}
const memory = () => createMemoryStore({ domain: 'memory' })
const change = (seq: number, value: number, before?: StoredNode) => storeCommit(seq, [storedNode('/item', { value })], before === undefined ? [] : [before])
async function apply(store: Store, cache: ReturnType<typeof createProcessCache>, commit: StoreCommit) {
  await store.commit(commit)
  cache.apply(store, commit)
}
function move(seq: number, before: StoredNode, path: string): StoreCommit {
  const pos = position(seq), after = { ...before, $path: path, $pos: pos }
  return { pos, writerEpoch: 1, writes: [{ path: before.$path, node: null }, { path, node: after }], record: {
    pos, kind: 'commit', caller: 'kernel', executor: 'kernel', entries: [{ id: before.$id, path, from: before.$path,
      change: { t: 'update', after, delta: { $path: { from: before.$path, to: path } } } }],
  } }
}

describe('process cache', { timeout: 10_000 }, () => {
  it('rejects a late Store query before installing it under a longer operation budget', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const held = delayed(memory()), cache = createProcessCache({ queryMs: () => 10 })
    await held.store.commit(change(1, 1))
    const pending = cache.fill(held.store, { node: '/item' }, { ...scanBudget(), deadline: Date.now() + 1000 })
    await held.entered.promise; t.mock.timers.tick(11); held.release.resolve()
    await assert.rejects(pending, refused('BUDGET'))
    assert.equal(cache.getAt(held.store, '/item'), undefined)
  })

  it('keeps the parent deadline when it is shorter than the Store query allowance', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const held = delayed(memory()), cache = createProcessCache({ queryMs: () => 100 })
    await held.store.commit(change(1, 1))
    const pending = cache.fill(held.store, { node: '/item' }, { ...scanBudget(), deadline: Date.now() + 2 })
    await held.entered.promise; t.mock.timers.tick(3); held.release.resolve()
    await assert.rejects(pending, refused('BUDGET'))
    assert.equal(cache.getAt(held.store, '/item'), undefined)
  })

  it('does not start a query allowance for an exact process-cache hit', async () => {
    const store = memory(), cache = createProcessCache({ queryMs() { throw new Error('No Store query expected') } })
    await apply(store, cache, change(1, 1))
    const read = await cache.fill(store, { node: '/item' }, scanBudget())
    assert.equal(read.nodes[0].value, 1); read.release()
  })

  it('isolates exact-path hits and in-flight fills between Stores sharing a transaction domain', async () => {
    const root = memory(), alias = memory(), cache = createProcessCache()
    await apply(root, cache, storeCommit(1, [storedNode('/private', { secret: 'root-sensitive' })]))
    const absent = await cache.fill(alias, { node: '/private' }, scanBudget())
    assert.deepEqual(absent.nodes, [])
    absent.release()
    const held = delayed(alias), pending = cache.fill(alias, { children: '/' }, scanBudget())
    await held.entered.promise
    await apply(root, cache, storeCommit(2, [storedNode('/during-fill', { secret: 'root-sensitive' })]))
    held.release.resolve()
    const empty = await pending
    assert.deepEqual(empty.nodes, [])
    assert.equal(cache.getAt(alias, '/private'), undefined)
    assert.equal(cache.getAt(root, '/private')?.node?.secret, 'root-sensitive')
    empty.release()
  })

  it('keeps identical paths with distinct identities and rejects a duplicate identity from another Store', async () => {
    const root = memory(), alias = memory(), duplicate = memory(), cache = createProcessCache()
    const original = storedNode('/shared', { value: 'root' })
    await apply(root, cache, storeCommit(1, [original]))
    const other = { ...storedNode('/shared', { value: 'alias' }), $id: 'alias-id' }
    await apply(alias, cache, storeCommit(2, [other]))
    const rootRead = await cache.fill(root, { node: '/shared' }, scanBudget())
    const aliasRead = await cache.fill(alias, { node: '/shared' }, scanBudget())
    assert.equal(rootRead.nodes[0].value, 'root')
    assert.equal(aliasRead.nodes[0].value, 'alias')
    assert.equal(rootRead.nodes[0].$id, original.$id)
    assert.equal(aliasRead.nodes[0].$id, other.$id)
    await duplicate.commit(storeCommit(3, [{ ...original, $path: '/duplicate', value: 'corrupted' }]))
    await assert.rejects(cache.fill(duplicate, { subtree: '/' }, scanBudget()), refused('INVALID'))
    assert.throws(() => cache.apply(duplicate, storeCommit(3, [{ ...original, value: 'corrupted' }])), refused('INVALID'))
    assert.equal(cache.get(original.$id)?.node?.value, 'root')
    assert.equal(cache.getAt(duplicate, '/duplicate'), undefined)
    rootRead.release(); aliasRead.release()
  })

  it('learns journal checkpoint bytes while retaining the same shared node image', async () => {
    const store = memory(), cache = createProcessCache()
    await store.commit(change(1, 1))
    const read = await cache.fill(store, { node: '/item' }, scanBudget()), node = read.nodes[0]
    cache.seedJournalBytes(node.$id, node.$pos, 123)
    assert.equal(read.nodes[0], node)
    assert.equal(cache.get(node.$id)?.journalBytes, 123)
    assert.throws(() => cache.seedJournalBytes(node.$id, position(2), 456), refused('CONFLICT'))
    assert.equal(cache.get(node.$id)?.journalBytes, 123)
    read.release()
  })

  it('rejects a replacement image without its own journal entry before changing the cache', async () => {
    const store = memory(), cache = createProcessCache(), created = change(1, 1)
    await apply(store, cache, created)
    const before = created.writes[0].node, after = { ...before, $id: 'replacement', $pos: position(2) }
    const bad: StoreCommit = { pos: position(2), writerEpoch: 1, writes: [{ path: before.$path, node: after }],
      record: { pos: position(2), kind: 'commit', executor: 'kernel', caller: 'kernel', entries: [
        { id: before.$id, path: before.$path, change: { t: 'delete', before } },
      ] } }
    assert.throws(() => cache.apply(store, bad), refused('INVALID'))
    assert.deepEqual(cache.getAt(store, before.$path)?.node, before)
    await apply(store, cache, { ...bad, record: { ...bad.record, entries: [...bad.record.entries,
      { id: after.$id, path: after.$path, change: { t: 'create', after } }] } })
    assert.equal(cache.get(before.$id)?.node, null)
    assert.deepEqual(cache.getAt(store, after.$path)?.node, after)
    assert.equal(cache.get(after.$id)?.journalBytes, 0)
  })

  it('reads empty ranges and shares one held copy between concurrent fills', async () => {
    const store = memory(), cache = createProcessCache({ uncoveredBytes: 0 })
    const empty = await cache.fill(store, { children: '/' }, scanBudget())
    assert.deepEqual(empty.nodes, []); empty.release()
    await store.commit(change(1, 1))
    const held = delayed(store), budget = scanBudget()
    const first = cache.fill(held.store, { node: '/item' }, budget)
    const second = cache.fill(held.store, { node: '/item' }, budget)
    await held.entered.promise; held.release.resolve()
    const [one, two] = await Promise.all([first, second])
    assert.equal(held.scans, 1)
    assert.equal(one.nodes[0], two.nodes[0])
    one.release(); one.release()
    assert.equal(cache.size, 1)
    two.release()
    assert.equal(cache.size, 0)
  })

  it('applies a write during a fill once, retaining its last delta', async () => {
    const store = memory(), cache = createProcessCache({ uncoveredBytes: 0 }), first = change(1, 1)
    await store.commit(first)
    const held = delayed(store), filling = cache.fill(held.store, { node: '/item' }, scanBudget())
    await held.entered.promise
    const next = change(2, 2, first.writes[0].node)
    await apply(store, cache, next)
    held.release.resolve()
    const read = await filling
    assert.equal(read.nodes[0].value, 2)
    assert.deepEqual(read.nodes[0].$pos, position(2))
    assert.deepEqual(cache.get(read.nodes[0].$id)?.delta?.value, { from: 1, to: 2 })
    read.release(); assert.equal(cache.size, 0)
  })

  it('keeps a newer cached state when a later range snapshot is older', async () => {
    const store = memory(), cache = createProcessCache(), first = change(1, 1)
    await store.commit(first)
    const read = await cache.fill(store, { node: '/item' }, scanBudget())
    cache.apply(store, change(2, 2, first.writes[0].node))
    const later = await cache.fill(store, { children: '/' }, scanBudget())
    assert.equal(later.nodes[0].value, 2)
    assert.equal(read.nodes[0], later.nodes[0])
    assert.deepEqual(cache.getAt(store, '/item')?.pos, position(2))
    later.release(); read.release()
  })

  it('does not roll back a snapshot that already includes an unpublished write', async () => {
    const store = memory(), cache = createProcessCache()
    await store.commit(change(2, 2))
    const read = await cache.fill(store, { node: '/item' }, scanBudget())
    cache.apply(store, change(1, 1))
    assert.equal(cache.getAt(store, '/item')?.node?.value, 2)
    cache.apply(store, change(2, 2))
    assert.equal(read.nodes[0].value, 2)
    assert.equal(cache.getAt(store, '/item')?.node, read.nodes[0])
    read.release()
  })

  it('incorporates creation and deletion during a range fill', async () => {
    const store = memory(), cache = createProcessCache({ uncoveredBytes: 0 }), first = change(1, 1)
    await store.commit(first)
    const held = delayed(store), filling = cache.fill(held.store, { children: '/' }, scanBudget())
    await held.entered.promise
    const pos = position(2), node = { ...storedNode('/new'), $pos: pos }
    await apply(store, cache, { pos, writerEpoch: 1, writes: [{ path: '/item', node: null }, { path: '/new', node }], record: {
      pos, kind: 'commit', caller: 'kernel', executor: 'kernel', entries: [
        { id: first.writes[0].node.$id, path: '/item', change: { t: 'delete', before: first.writes[0].node } },
        { id: node.$id, path: node.$path, change: { t: 'create', after: node } },
      ],
    } })
    held.release.resolve()
    const read = await filling
    assert.deepEqual(read.nodes.map(node => node.$path), ['/new'])
    assert.equal(cache.getAt(store, '/item'), undefined)
    read.release()
  })

  it('keeps the write delta when the fill already read its full after image', async () => {
    const store = memory(), cache = createProcessCache(), first = change(1, 1), next = change(2, 2, first.writes[0].node)
    await store.commit(first); await store.commit(next)
    const read = await cache.fill(store, { node: '/item' }, scanBudget())
    cache.apply(store, next)
    assert.deepEqual(cache.getAt(store, '/item')?.delta?.value, { from: 1, to: 2 })
    assert.equal(read.nodes[0].value, 2)
    read.release()
  })

  it('follows moves of one identity and removes it from its former range', async () => {
    const store = memory(), cache = createProcessCache(), first = storeCommit(1, [storedNode('/old/item', { value: 5 })])
    await store.commit(first)
    const held = delayed(store), filling = cache.fill(held.store, { children: '/old' }, scanBudget())
    await held.entered.promise
    await apply(store, cache, move(2, first.writes[0].node, '/new/item'))
    held.release.resolve()
    const read = await filling
    assert.deepEqual(read.nodes, [])
    assert.equal(cache.getAt(store, '/old/item'), undefined)
    assert.equal(cache.getAt(store, '/new/item')?.node?.$id, first.writes[0].node.$id)
    assert.equal(cache.getAt(store, '/new/item')?.node?.value, 5)
    read.release()
  })

  it('indexes two identities exchanging paths in one commit', () => {
    const store = memory(), cache = createProcessCache(), first = storeCommit(1, [storedNode('/a'), storedNode('/b')])
    cache.apply(store, first)
    const a = move(2, first.writes[0].node, '/b'), b = move(2, first.writes[1].node, '/a')
    cache.apply(store, { ...a, writes: [a.writes[1], b.writes[1]], record: { ...a.record, entries: [...a.record.entries, ...b.record.entries] } })
    assert.equal(cache.getAt(store, '/a')?.node?.$id, first.writes[1].node.$id)
    assert.equal(cache.getAt(store, '/b')?.node?.$id, first.writes[0].node.$id)
  })

  it('preserves covered nodes under a zero uncovered-byte bound', async () => {
    const store = memory(), cache = createProcessCache({ uncoveredBytes: 0 })
    await store.commit(change(1, 1))
    const read = await cache.fill(store, { node: '/item' }, scanBudget())
    const release = cache.retain(read.nodes[0].$id)
    read.release()
    cache.apply(store, storeCommit(2, [storedNode('/other')]))
    assert.equal(cache.size, 1)
    assert.equal(cache.uncoveredBytes, 0)
    assert.equal(cache.getAt(store, '/item')?.node?.value, 1)
    release(); assert.equal(cache.size, 0)
  })

  it('evicts uncovered copies to the byte bound and preserves source ownership', () => {
    const store = memory(), cache = createProcessCache({ uncoveredBytes: 400 }), nested = { value: 1 }
    const first = storeCommit(1, [storedNode('/item', { nested })])
    cache.apply(store, first)
    nested.value = 99
    assert.deepEqual(cache.getAt(store, '/item')?.node?.nested, { value: 1 })
    const copy = cache.getAt(store, '/item')?.node
    assert.ok(copy)
    assert.equal(Reflect.set(copy, 'value', 99), false)
    cache.apply(store, storeCommit(2, [storedNode('/other', { padding: 'x'.repeat(300) })]))
    assert.equal(cache.getAt(store, '/item'), undefined)
    assert.ok(cache.uncoveredBytes <= 400)
  })

  it('updates one copy even when a thousand readers hold it', async () => {
    const store = memory(), cache = createProcessCache({ uncoveredBytes: 0 })
    await store.commit(change(1, 1))
    const readers = await Promise.all(Array.from({ length: 1000 }, () => cache.fill(store, { node: '/item' }, scanBudget())))
    await apply(store, cache, change(2, 2, readers[0].nodes[0]))
    const current = cache.getAt(store, '/item')?.node
    assert.equal(cache.size, 1)
    for (const reader of readers) { assert.equal(reader.nodes[0], current); reader.release() }
    assert.equal(cache.size, 0)
  })

  it('rejects an overflowing fill buffer and permits a fresh read afterward', async () => {
    const store = memory(), cache = createProcessCache({ fillBytes: 1 })
    await store.commit(change(1, 1))
    const held = delayed(store), filling = cache.fill(held.store, { children: '/' }, scanBudget())
    const failure = assert.rejects(filling, refused('BUDGET'))
    await held.entered.promise
    await apply(store, cache, change(2, 2))
    held.release.resolve(); await failure
    const read = await cache.fill(store, { children: '/' }, scanBudget())
    assert.equal(read.nodes[0].value, 2)
    read.release()
  })

  it('enforces budgets on cache hits and on nodes added during a fill', async () => {
    const store = memory(), cache = createProcessCache()
    await apply(store, cache, change(1, 1))
    for (const budget of [{ ...scanBudget(), nodes: 0 }, { ...scanBudget(), bytes: 1 }, { ...scanBudget(), deadline: 0 }]) {
      await assert.rejects(() => cache.fill(store, { node: '/item' }, budget), refused('BUDGET'))
    }
    const held = delayed(store), filling = cache.fill(held.store, { children: '/' }, { ...scanBudget(), nodes: 1 })
    const failure = assert.rejects(filling, refused('BUDGET'))
    await held.entered.promise
    await apply(store, cache, storeCommit(2, [storedNode('/other')]))
    held.release.resolve(); await failure
    assert.equal(cache.getAt(store, '/other')?.node?.$path, '/other')
  })

  it('expires a fill whose Store read completed after the query deadline', async t => {
    let clock = 100
    t.mock.method(Date, 'now', () => clock)
    const store = memory(), cache = createProcessCache()
    await store.commit(change(1, 1))
    const held = delayed(store), budget = scanBudget(), filling = cache.fill(held.store, { node: '/item' }, budget)
    const failure = assert.rejects(filling, refused('BUDGET'))
    await held.entered.promise; clock = budget.deadline + 1
    held.release.resolve(); await failure
    assert.equal(cache.size, 0)
  })

  it('retries the same fill after a rejected Store read', async t => {
    const store = memory(), cache = createProcessCache(), error = new Error('Read failed'), budget = scanBudget()
    await store.commit(change(1, 1))
    t.mock.method(store, 'scan', () => Promise.reject(error), { times: 1 })
    await assert.rejects(() => cache.fill(store, { node: '/item' }, budget), (actual: unknown) => actual === error)
    const read = await cache.fill(store, { node: '/item' }, budget)
    assert.equal(read.nodes[0].value, 1)
    read.release()
  })

  it('rejects a malformed journal before changing any cached image', () => {
    const store = memory(), cache = createProcessCache(), first = change(1, 1), next = change(2, 2)
    cache.apply(store, first)
    assert.throws(() => cache.apply(store, { ...next, writes: [] }), refused('INVALID'))
    assert.throws(() => cache.apply(store, { ...next, record: { ...next.record, entries: [] } }), refused('INVALID'))
    assert.equal(cache.getAt(store, '/item')?.node?.value, 1)
    cache.apply(store, next)
    assert.equal(cache.getAt(store, '/item')?.node?.value, 2)
  })
})

describe('writer process cache', { timeout: 10_000 }, () => {
  it('updates the shared cache before releasing later read-domain checks', async () => {
    const a = createMemoryStore({ domain: 'a' }), b = createMemoryStore({ domain: 'b' }), c = createMemoryStore({ domain: 'c' })
    const writer = await createWriter({ instance: 'test', root: a, writerEpoch: 1, domains: [a, b, c].map(store => ({ store, epoch: '1', persistent: false })),
      counter: { async load() { return undefined }, async save() {}, async freshEpoch(floor) { return floor + 1 } }, budget: scanBudget })
    const entered = signal(), release = signal(), applied = signal()
    const prepare = (pos: typeof writer.position, path: string) => {
      const data = storeCommit(pos.seq, [{ ...storedNode(path, { value: 2 }), $pos: pos }])
      return { writes: data.writes, record: { ...data.record, pos } }
    }
    const first = writer.commit(a, [], async pos => { entered.resolve(); await release.promise; return prepare(pos, '/a') })
    await entered.promise
    const second = writer.commit(b, [], pos => { applied.resolve(); return prepare(pos, '/b') })
    await applied.promise
    const third = writer.commit(c, ['b'], pos => {
      assert.equal(writer.cache.getAt(b, '/b')?.node?.value, 2)
      return prepare(pos, '/c')
    })
    release.resolve()
    await Promise.all([first, second, third])
    assert.equal(writer.cache.getAt(c, '/c')?.node?.value, 2)
  })

  it('keeps failed commits out of the cache', async () => {
    const store = memory(), writer = await createWriter({ instance: 'test', root: store, writerEpoch: 1,
      domains: [{ store, epoch: '1', persistent: false }], counter: { async load() { return undefined }, async save() {}, async freshEpoch(floor) { return floor + 1 } } })
    const error = new Error('Prepare failed')
    await assert.rejects(() => writer.commit(store, [], () => { throw error }), (actual: unknown) => actual === error)
    assert.equal(writer.cache.size, 0)
  })
})
