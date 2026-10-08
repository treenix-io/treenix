import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { readJournalImages } from '#kernel/journal'
import { createMemoryStore } from '#kernel/store/memory'
import { DEFAULT_LIMITS, type JournalAddress, type JournalEntry, type StoredNode } from '#kernel/types'
import { isUlid } from '#util/ulid'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

describe('subtree relocation', () => {
  it('preserves every identity and payload, records old paths and removes every old address', async () => {
    const f = await fixture()
    await f.commit([put('/old', { label: 'root' }, 'dir'), put('/old/child', { value: 1 }), put('/old/child/deep', { value: 2 })])
    const before = await f.nodes()
    const pos = await f.commit([{ op: 'move', from: '/old', to: '/new' }])
    const after = await f.nodes(), records = await f.journal(), entries = records.at(-1)!.entries
    assert.equal(after.length, before.length)
    for (const node of before) {
      const path = '/new' + node.$path.slice('/old'.length), relocated = after.find(next => next.$id === node.$id)
      assert.deepEqual(relocated, { ...node, $path: path, $pos: pos })
      assert.equal(entries.find(entry => entry.id === node.$id)?.from, node.$path)
      assert.deepEqual(readJournalImages(records, { pos, id: node.$id }), { before: node, after: relocated })
      assert.equal(f.cache.getAt(f.store, node.$path), undefined)
      assert.equal(f.cache.getAt(f.store, path)?.node?.$id, node.$id)
    }
    assert.equal(after.some(node => node.$type === 'moved'), false)
  })

  it('includes descendants behind absent intermediate nodes and removes them too', async () => {
    const f = await fixture()
    await f.commit([put('/old', {}, 'dir'), put('/old/gap/deeper/leaf', { value: 1 })])
    const before = await f.nodes()
    await f.commit([{ op: 'move', from: '/old', to: '/new' }])
    assert.deepEqual((await f.nodes()).map(node => node.$path), ['/new', '/new/gap/deeper/leaf'])
    assert.deepEqual((await f.nodes()).map(node => node.$id).sort(), before.map(node => node.$id).sort())
    await f.commit([{ op: 'remove', path: '/new' }])
    assert.deepEqual(await f.nodes(), [])
    await f.commit([put('/orphan/gap/deep')])
    await f.commit([{ op: 'remove', path: '/orphan' }])
    assert.deepEqual(await f.nodes(), [])
  })

  it('rejects root, self, descendant and invalid path arguments atomically', async () => {
    const f = await fixture()
    await f.commit([put('/old', {}, 'dir'), put('/sibling', { value: 1 })])
    const before = await f.nodes()
    for (const [from, to] of [['/', '/new'], ['/old', '/'], ['/old', '/old'], ['/old', '/old/deep'], ['/old', '/bad/../path']]) {
      await assert.rejects(f.commit([{ op: 'patch', path: '/sibling', ops: { $inc: { value: 1 } } },
        { op: 'move', from, to }]), code('INVALID'))
      assert.deepEqual(await f.nodes(), before)
    }
    await assert.rejects(f.commit([{ op: 'move', from: '/missing', to: '/new' }]), code('NOT_FOUND'))
    assert.deepEqual(await f.nodes(), before)
  })

  it('rejects occupied destination roots and orphaned destination descendants', async () => {
    const f = await fixture()
    await f.commit([put('/old', {}, 'dir'), put('/occupied'), put('/sparse/gap/deep')])
    const before = await f.nodes()
    for (const to of ['/occupied', '/sparse']) {
      await assert.rejects(f.commit([{ op: 'move', from: '/old', to }]), code('CONFLICT'))
      assert.deepEqual(await f.nodes(), before)
    }
  })

  it('stops below mount nodes while moving the declaring node itself', async () => {
    const f = await fixture({ boundary: path => path === '/old/mount' })
    await f.commit(['/old', '/old/child', '/old/mount', '/old/mount/hidden'].map(path => put(path, {}, 'dir')))
    const before = await f.nodes(), hidden = before.find(node => node.$path === '/old/mount/hidden')
    await f.commit([{ op: 'move', from: '/old', to: '/new' }])
    assert.deepEqual((await f.nodes()).map(node => node.$path), ['/new', '/new/child', '/new/mount', '/old/mount/hidden'])
    assert.deepEqual((await f.nodes()).find(node => node.$path === '/old/mount/hidden'), hidden)
    assert.equal((await f.journal()).at(-1)!.entries.length, 3)
  })

  it('allows the exact node cap and rejects the next node without a partial move', async () => {
    const f = await fixture({ limits: { ...DEFAULT_LIMITS, changeSet: 2 } })
    await f.commit([put('/old', {}, 'dir'), put('/old/one')])
    await f.commit([{ op: 'move', from: '/old', to: '/new' }])
    assert.deepEqual((await f.nodes()).map(node => node.$path), ['/new', '/new/one'])
    await f.commit([put('/new/two')])
    const before = await f.nodes(), records = await f.journal()
    await assert.rejects(f.commit([{ op: 'move', from: '/new', to: '/later' }]), code('BUDGET'))
    assert.deepEqual(await f.nodes(), before); assert.deepEqual(await f.journal(), records)
  })

  it('respects earlier removal, relocation and patch members in the same batch', async () => {
    const f = await fixture()
    await f.commit([put('/old', { value: 1 }, 'dir'), put('/old/child'), put('/occupied')])
    const before = (await f.nodes()).find(node => node.$path === '/old')!
    const pos = await f.commit([{ op: 'remove', path: '/occupied' }, { op: 'move', from: '/old', to: '/occupied' },
      { op: 'move', from: '/occupied', to: '/final' }, { op: 'patch', path: '/final', ops: { $inc: { value: 1 } } }])
    const nodes = await f.nodes(), after = nodes.find(node => node.$id === before.$id)
    assert.deepEqual(nodes.map(node => node.$path), ['/final', '/final/child'])
    assert.equal(after?.value, 2)
    const entry = (await f.journal()).at(-1)!.entries.find(record => record.id === before.$id)
    assert.equal(entry?.from, '/old'); assert.equal(entry?.path, '/final')
    assert.deepEqual(readJournalImages(await f.journal(), { pos, id: before.$id }), { before, after })
  })

  it('rejects relocation across transaction domains before any write', async () => {
    const local = createMemoryStore({ domain: 'memory' }), foreign = createMemoryStore({ domain: 'foreign' })
    const f = await fixture({ store: local, resolve: path => path.startsWith('/foreign') ? foreign : local })
    await f.commit([put('/old')])
    const before = await f.nodes()
    await assert.rejects(f.commit([{ op: 'move', from: '/old', to: '/foreign/new' }]), code('CROSS_DOMAIN'))
    assert.deepEqual(await f.nodes(), before)
  })

  it('rejects distinct atomic Store owners even when their transaction domains match', async () => {
    const local = createMemoryStore({ domain: 'shared' })
    const foreign = createMemoryStore({ domain: 'shared' })
    const f = await fixture({ store: local, resolve: path => path.startsWith('/foreign') ? foreign : local })
    await f.commit([put('/old', { value: 1 })])
    const before = await f.nodes()
    const records = await f.journal()
    await assert.rejects(f.commit([
      { op: 'patch', path: '/old', ops: { $inc: { value: 1 } } },
      { op: 'move', from: '/old', to: '/foreign/new' },
    ]), code('CROSS_DOMAIN'))
    assert.deepEqual(await f.nodes(), before)
    assert.equal((await f.journal()).filter(record => record.entries.length > 0).length,
      records.filter(record => record.entries.length > 0).length)
    assert.deepEqual((await foreign.scan({ range: { subtree: '/' }, budget: {
      nodes: 100, bytes: 100_000, exprWork: 100_000, deadline: Date.now() + 1000,
    } })).items, [])
  })

  it('recreates path identities with a kernel identity instead of carrying the old path id', async () => {
    const f = await fixture()
    await f.writer.commit(f.store, [], pos => {
      const node: StoredNode = { $id: 'p:/old', $path: '/old', $type: 'item', $v: 1, $pos: pos, value: 1 }
      const entry: JournalEntry = { id: node.$id, path: node.$path, change: { t: 'create', after: node } }
      return { writes: [{ path: node.$path, node }], record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [entry] } }
    })
    const pos = await f.commit([{ op: 'move', from: '/old', to: '/new' }]), [after] = await f.nodes()
    assert.ok(isUlid(after.$id)); assert.notEqual(after.$id, 'p:/old')
    assert.equal(after.$path, '/new'); assert.equal(after.value, 1)
    const records = await f.journal()
    assert.equal(records.at(-1)!.entries.length, 2)
    assert.equal(readJournalImages(records, { pos, id: 'p:/old' }).after, null)
    assert.deepEqual(readJournalImages(records, { pos, id: after.$id }), { before: null, after })
  })
})

describe('restoring journal before-images', () => {
  async function deleted() {
    const f = await fixture()
    await f.commit([put('/', {}, 'dir'), put('/parent', {}, 'dir'), put('/parent/item', { value: 1 })])
    const before = await f.nodes(), pos = await f.commit([{ op: 'remove', path: '/parent' }])
    const parent = before.find(node => node.$path === '/parent')!, child = before.find(node => node.$path === '/parent/item')!
    return { ...f, parent, child, parentRecord: { pos, id: parent.$id }, childRecord: { pos, id: child.$id } }
  }

  it('restores a parent and then its child, preserving their identities and assigning the commit position', async () => {
    const f = await deleted(), pos = await f.commit([{ op: 'restore', record: f.parentRecord }, { op: 'restore', record: f.childRecord }])
    const nodes = await f.nodes()
    assert.deepEqual(nodes.find(node => node.$id === f.parent.$id), { ...f.parent, $pos: pos })
    assert.deepEqual(nodes.find(node => node.$id === f.child.$id), { ...f.child, $pos: pos })
    assert.equal((await f.journal()).at(-1)!.entries.length, 2)
  })

  it('rejects a missing parent and rejects child-before-parent without partially restoring it', async () => {
    const f = await deleted(), before = await f.nodes(), records = await f.journal()
    for (const changes of [[{ op: 'restore', record: f.childRecord }],
      [{ op: 'restore', record: f.childRecord }, { op: 'restore', record: f.parentRecord }]] as const) {
      await assert.rejects(f.commit(changes), code('NOT_FOUND'))
      assert.deepEqual(await f.nodes(), before); assert.deepEqual(await f.journal(), records)
    }
  })

  it('rejects an occupied path even when the occupying node has a different identity', async () => {
    const f = await deleted()
    await f.commit([put('/parent', { other: true }, 'dir')])
    const before = await f.nodes()
    await assert.rejects(f.commit([{ op: 'restore', record: f.parentRecord }]), code('CONFLICT'))
    assert.deepEqual(await f.nodes(), before)
  })

  it('rejects a living identity at another path', async () => {
    const f = await fixture()
    await f.commit([put('/', {}, 'dir'), put('/item', { value: 1 })])
    const source = (await f.nodes()).find(node => node.$path === '/item')!
    const pos = await f.commit([{ op: 'move', from: '/item', to: '/elsewhere' }])
    const before = await f.nodes()
    await assert.rejects(f.commit([{ op: 'restore', record: { pos, id: source.$id } }]), code('CONFLICT'))
    assert.deepEqual(await f.nodes(), before)
  })

  it('allows earlier removal of the same identity and retains the original commit before-image', async () => {
    const f = await fixture()
    await f.commit([put('/', {}, 'dir'), put('/item', { value: 1 })])
    const old = (await f.nodes()).find(node => node.$path === '/item')!
    const edit = await f.commit([{ op: 'patch', path: '/item', ops: { $set: { value: 2 } } }])
    const before = (await f.nodes()).find(node => node.$path === '/item')!
    const pos = await f.commit([{ op: 'remove', path: '/item' }, { op: 'restore', record: { pos: edit, id: old.$id } }])
    const after = (await f.nodes()).find(node => node.$path === '/item')!
    assert.equal(after.$id, old.$id); assert.equal(after.value, 1)
    assert.deepEqual(readJournalImages(await f.journal(), { pos, id: old.$id }), { before, after })
    assert.equal((await f.journal()).at(-1)!.entries.length, 1)
  })

  it('rejects a creation record with no before and an absent journal address', async () => {
    const f = await fixture(), created = await f.commit([put('/', {}, 'dir'), put('/item')])
    const node = (await f.nodes()).find(node => node.$path === '/item')!
    await f.commit([{ op: 'remove', path: '/item' }])
    await assert.rejects(f.commit([{ op: 'restore', record: { pos: created, id: node.$id } }]), code('INVALID'))
    const absent: JournalAddress = { pos: { ...created, seq: created.seq + 100 }, id: node.$id }
    await assert.rejects(f.commit([{ op: 'restore', record: absent }]), code('NOT_FOUND'))
    assert.equal((await f.nodes()).some(node => node.$path === '/item'), false)
  })

  it('reconstructs a reversible delta before-image for restoration', async () => {
    const f = await fixture()
    await f.commit([put('/', {}, 'dir'), put('/item', { value: 1, payload: 'x'.repeat(1024) })])
    const original = (await f.nodes()).find(node => node.$path === '/item')!
    const edit = await f.commit([{ op: 'patch', path: '/item', ops: { $inc: { value: 1 } } }])
    const entry = (await f.journal()).at(-1)!.entries[0]
    assert.equal(entry.change.t, 'update'); assert.equal('after' in entry.change, false)
    await f.commit([{ op: 'remove', path: '/item' }])
    const pos = await f.commit([{ op: 'restore', record: { pos: edit, id: original.$id } }])
    assert.deepEqual((await f.nodes()).find(node => node.$path === '/item'), { ...original, $pos: pos })
  })
})
