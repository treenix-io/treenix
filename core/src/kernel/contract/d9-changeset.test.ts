import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createProcessCache } from '#kernel/cache'
import { readJournalImages } from '#kernel/journal'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import { DEFAULT_LIMITS, type DecisionRange, type JournalCommit, type JournalRange,
  type ScanQuery, type ScanRange, type ScanResult, type Store, type StoredNode } from '#kernel/types'
import { isUlid } from '#util/ulid'
import { fixture, input, put } from '#kernel/contract/changeset-fixture'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

function editable(base: Store) {
  const edits = new Map<string, StoredNode>()
  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
    const range = query.range
    if ('journal' in range || 'decision' in range) return base.scan({ ...query, range })
    const rows = await base.scan({ ...query, range })
    return { ...rows, items: rows.items.map(node => edits.get(node.$path) ?? node) }
  }
  const store: Store = { ...base, scan, async commit(commit) {
    await base.commit(commit)
    for (const write of commit.writes) edits.delete(write.path)
  } }
  return { store, edit(node: StoredNode) { edits.set(node.$path, structuredClone(node)) } }
}

describe('ordered ChangeSet preparation', () => {
  it('issues identity, canonicalizes every component and stamps current versions', async () => {
    const f = await fixture(), pos = await f.commit([put('/item', {
      value: 1, '#extra': { $type: 'old.extra', value: 'named' },
    }, 'old.item')])
    const [node] = await f.nodes()
    assert.ok(isUlid(node.$id))
    assert.equal(node.$type, 'item'); assert.equal(node.$v, 1)
    assert.deepEqual(node['#extra'], { $type: 'extra', $v: 2, value: 'named' })
    assert.deepEqual(node.$pos, pos)
    assert.equal(Object.hasOwn(node, '$rev'), false)
  })

  it('rejects supplied kernel metadata even when its value is undefined', async () => {
    const f = await fixture()
    for (const field of ['$id', '$rev', '$pos']) for (const value of ['chosen', undefined]) {
      const node = input('/invalid')
      Object.defineProperty(node, field, { value, enumerable: true })
      await assert.rejects(f.commit([put('/good'), { op: 'put', node }]), code('INVALID'))
      assert.deepEqual(await f.nodes(), [])
    }
  })

  it('rejects old main and named versions atomically and accepts explicit current versions', async () => {
    const f = await fixture()
    for (const fields of [{ $v: 0 }, { '#extra': { $type: 'extra', $v: 1 } }]) {
      await assert.rejects(f.commit([put('/good'), put('/invalid', fields)]), code('INVALID'))
      assert.deepEqual(await f.nodes(), [])
    }
    await f.commit([put('/current', { $v: 1, '#extra': { $type: 'extra', $v: 2 } })])
    assert.equal((await f.nodes())[0].$v, 1)
  })

  it('rejects an occupied type change and accepts explicit removal before a new identity', async () => {
    const f = await fixture()
    await f.commit([put('/item', { value: 1 })])
    const [before] = await f.nodes()
    await assert.rejects(f.commit([put('/item', { value: 2 }, 'other')]), code('CONFLICT'))
    assert.deepEqual(await f.nodes(), [before])
    const pos = await f.commit([{ op: 'remove', path: '/item' }, put('/item', { value: 2 }, 'other')])
    const [after] = await f.nodes()
    assert.notEqual(after.$id, before.$id)
    assert.equal(after.$type, 'other')
    assert.equal(f.cache.getAt(f.store, '/item')?.node?.$id, after.$id)
    assert.equal(f.cache.get(before.$id)?.node, null)
    const record = (await f.journal()).at(-1)!
    assert.equal(record.entries.length, 2)
    assert.deepEqual(readJournalImages(await f.journal(), { pos, id: before.$id }), { before, after: null })
    assert.deepEqual(readJournalImages(await f.journal(), { pos, id: after.$id }), { before: null, after })
  })

  it('applies repeated members in order and journals one net update per identity', async () => {
    const f = await fixture()
    await f.commit([put('/item', { value: 1, obsolete: true })])
    const [before] = await f.nodes()
    const pos = await f.commit([
      { op: 'patch', path: '/item', ops: { $inc: { value: 2 }, $unset: { obsolete: true } } },
      { op: 'patch', path: '/item', ops: { $inc: { value: 3 }, $set: { added: null } } },
    ])
    const [after] = await f.nodes()
    assert.equal(after.value, 6); assert.equal(after.$id, before.$id)
    assert.equal(Object.hasOwn(after, 'obsolete'), false); assert.equal(after.added, null)
    assert.equal((await f.journal()).at(-1)!.entries.length, 1)
    assert.deepEqual(readJournalImages(await f.journal(), { pos, id: before.$id }), { before, after })
  })

  it('rejects patching identity, position or address, including dotted descendants', async () => {
    const f = await fixture()
    await f.commit([put('/item')])
    const before = await f.nodes()
    for (const field of ['$id', '$rev', '$pos', '$pos.seq', '$path']) {
      await assert.rejects(f.commit([{ op: 'patch', path: '/item', ops: { $set: { [field]: 'chosen' } } }]), code('INVALID'))
      assert.deepEqual(await f.nodes(), before)
    }
  })

  it('removes descendants but stops below mount nodes and leaves unrelated siblings', async () => {
    const f = await fixture({ boundary: path => path === '/root/mount' })
    await f.commit(['/root', '/root/child', '/root/child/deep', '/root/mount', '/root/mount/hidden', '/sibling'].map(path => put(path, {}, 'dir')))
    await f.commit([{ op: 'remove', path: '/root' }])
    assert.deepEqual((await f.nodes()).map(node => node.$path), ['/root/mount/hidden', '/sibling'])
    assert.equal((await f.journal()).at(-1)!.entries.length, 4)
  })

  it('removes staged descendants and orphaned descendants in member order', async () => {
    const f = await fixture()
    await f.commit([put('/parent', {}, 'dir'), put('/parent/new'), { op: 'remove', path: '/parent' }])
    assert.deepEqual(await f.nodes(), [])
    assert.deepEqual((await f.journal()).at(-1)!.entries, [])
    await f.commit([put('/orphan/child')])
    await f.commit([{ op: 'remove', path: '/orphan' }])
    assert.deepEqual(await f.nodes(), [])
  })

  it('allows the exact transition limit and rejects the next descendant without partial deletion', async () => {
    const f = await fixture()
    const hundred = [put('/parent', {}, 'dir'), ...Array.from({ length: 99 }, (_, i) => put(`/parent/n${i}`))]
    await f.commit(hundred)
    await f.commit([{ op: 'remove', path: '/parent' }])
    assert.deepEqual(await f.nodes(), [])
    await f.commit(hundred)
    await f.commit([put('/parent/last')])
    const before = await f.nodes()
    await assert.rejects(f.commit([{ op: 'remove', path: '/parent' }]), code('BUDGET'))
    assert.deepEqual(await f.nodes(), before)
    const g = await fixture()
    await assert.rejects(g.commit(Array.from({ length: 101 }, (_, i) => put(`/n${i}`))), code('BUDGET'))
    assert.deepEqual(await g.nodes(), [])
  })

  it('counts stored UTF-8 node bytes and rejects oversized nodes atomically', async () => {
    const f = await fixture()
    for (const payload of ['x'.repeat(257 * 1024), 'я'.repeat(130 * 1024)]) {
      await assert.rejects(f.commit([put('/good'), put('/oversized', { payload })]), code('BUDGET'))
      assert.deepEqual(await f.nodes(), [])
    }
    await f.commit([put('/fits', { payload: 'x'.repeat(200 * 1024) })])
    assert.equal((await f.nodes()).length, 1)
  })

  it('rejects foreign domains and unregistered main or named types without publishing earlier members', async () => {
    const foreign = createMemoryStore({ domain: 'foreign' }), local = createMemoryStore({ domain: 'memory' })
    const f = await fixture({ store: local, resolve: path => path.startsWith('/foreign') ? foreign : local })
    await assert.rejects(f.commit([put('/good'), put('/foreign/item')]), code('CROSS_DOMAIN'))
    assert.deepEqual(await f.nodes(), [])
    for (const bad of [put('/bad', {}, 'missing'), put('/bad', { '#unknown': { $type: 'missing' } })]) {
      await assert.rejects(f.commit([put('/good'), bad]), code('UNKNOWN_TYPE'))
      assert.deepEqual(await f.nodes(), [])
    }
    assert.deepEqual((await foreign.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
  })

  it('leaves every earlier member unchanged when a later patch is absent or invalid', async () => {
    const f = await fixture()
    await f.commit([put('/a', { value: 1 }), put('/b', { value: 'text' })])
    const before = await f.nodes(), records = await f.journal()
    for (const [target, expected] of [['/missing', 'NOT_FOUND'], ['/b', 'INVALID']] as const) {
      await assert.rejects(f.commit([
        { op: 'patch', path: '/a', ops: { $inc: { value: 2 } } },
        { op: 'patch', path: target, ops: { $inc: { value: 1 } } },
      ]), code(expected))
      assert.deepEqual(await f.nodes(), before)
      assert.deepEqual(await f.journal(), records)
    }
  })

  it('keeps data, cache and journal unchanged when Store staging fails', async () => {
    let fail = false
    const failure = new Error('Disk staging failed')
    const store = createMemoryStore({ domain: 'memory', beforeRecord() { if (fail) throw failure } })
    const f = await fixture({ store })
    await f.commit([put('/a', { value: 1 }), put('/b', { value: 2 })])
    const before = await f.nodes(), records = await f.journal()
    fail = true
    await assert.rejects(f.commit([{ op: 'patch', path: '/a', ops: { $inc: { value: 1 } } },
      { op: 'patch', path: '/b', ops: { $inc: { value: 1 } } }]), error => error === failure)
    assert.deepEqual(await f.nodes(), before); assert.deepEqual(await f.journal(), records)
    assert.deepEqual(f.cache.getAt(f.store, '/a')?.node, before[0])
  })

  it('writes the whole cached before over an undetected external edit', async () => {
    const disk = editable(createMemoryStore({ domain: 'memory' })), f = await fixture({ store: disk.store })
    await f.commit([put('/item', { value: 1, label: 'cached', payload: 'x'.repeat(1024) })])
    const [before] = await f.nodes()
    disk.edit({ ...before, label: 'external' })
    const pos = await f.commit([{ op: 'patch', path: '/item', ops: { $inc: { value: 1 } } }])
    const [after] = await f.nodes()
    assert.equal(after.label, 'cached'); assert.equal(after.value, 2)
    assert.deepEqual(readJournalImages(await f.journal(), { pos, id: before.$id }), { before, after })
  })

  it('anchors an externally edited before loaded under the preceding position', async () => {
    const disk = editable(createMemoryStore({ domain: 'memory' }))
    const f = await fixture({ store: disk.store, cache: createProcessCache({ uncoveredBytes: 0 }) })
    await f.commit([put('/item', { value: 1, label: 'cached', payload: 'x'.repeat(1024) })])
    const before = { ...(await f.nodes())[0], label: 'external' }
    disk.edit(before)
    const pos = await f.commit([{ op: 'patch', path: '/item', ops: { $inc: { value: 1 } } }])
    const [after] = await f.nodes(), last = (await f.journal()).at(-1)!.entries[0]
    assert.equal(last.change.t, 'update'); assert.ok('after' in last.change)
    assert.equal(after.label, 'external'); assert.equal(after.value, 2)
    assert.deepEqual(readJournalImages(await f.journal(), { pos, id: before.$id }), { before, after })
  })

  it('recovers cumulative journal bytes after cache eviction instead of resetting every update', async () => {
    const f = await fixture({ cache: createProcessCache({ uncoveredBytes: 0 }) })
    await f.commit([put('/item', { value: 1, payload: 'x'.repeat(1024) })])
    let pos = f.writer.position
    for (let i = 0; i < 30; i++) pos = await f.commit([{ op: 'patch', path: '/item', ops: { $inc: { value: 1 } } }])
    const records = await f.journal(), updates = records.flatMap(record => record.entries).filter(entry => entry.change.t === 'update')
    const full = updates.filter(entry => 'after' in entry.change).length
    assert.ok(full > 0 && full < updates.length)
    const [after] = await f.nodes()
    assert.equal(after.value, 31)
    assert.deepEqual(readJournalImages(records, { pos, id: after.$id }).after, after)
  })

  it('serializes concurrent increments against the shared process copy', async () => {
    const f = await fixture()
    await f.commit([put('/item', { value: 1 })])
    await Promise.all(Array.from({ length: 10 }, () => f.commit([{ op: 'patch', path: '/item', ops: { $inc: { value: 1 } } }])))
    assert.equal((await f.nodes())[0].value, 11)
    assert.equal(f.cache.getAt(f.store, '/item')?.node?.value, 11)
  })

  it('keeps preparation before-images out of the Store commit payload', async () => {
    const base = createMemoryStore({ domain: 'memory' })
    let receivedBytes = 0
    const store: Store = { ...base, async commit(commit) {
      receivedBytes = Buffer.byteLength(JSON.stringify(commit))
      await base.commit(commit)
    } }
    const f = await fixture({ store })
    await f.commit([put('/item', { payload: 'x'.repeat(200 * 1024), value: 1 })])
    const [before] = await f.nodes()
    await f.commit([{ op: 'patch', path: '/item', ops: { $inc: { value: 1 } } }])
    assert.ok(receivedBytes < 2 * Buffer.byteLength(JSON.stringify(before)))
    assert.equal((await f.nodes())[0].value, 2)
  })

  it('applies live limits supplied by the caller to the whole expanded batch', async () => {
    const f = await fixture({ limits: { ...DEFAULT_LIMITS, changeSet: 1 } })
    await assert.rejects(f.commit([put('/one'), put('/two')]), code('BUDGET'))
    assert.deepEqual(await f.nodes(), [])
    await f.commit([put('/one')])
    assert.equal((await f.nodes()).length, 1)
  })
})
