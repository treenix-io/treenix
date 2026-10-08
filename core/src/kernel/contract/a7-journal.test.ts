import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { applyFieldDeltas, compactJournal, computeFieldDeltas, encodeJournalEntry, encodeReconciliation, readJournalImages } from '#kernel/journal'
import { position, storedNode } from '#kernel/store/contract'
import type { JournalCommit, JournalEntry, StoredNode } from '#kernel/types'

const node = (seq: number, fields: Record<string, unknown> = {}, path = '/item', id = 'item'): StoredNode => ({
  ...storedNode(path, fields), $id: id, $pos: position(seq),
})
const record = (seq: number, entries: readonly JournalEntry[], extra: Partial<JournalCommit> = {}): JournalCommit => ({
  pos: position(seq), kind: 'commit', executor: 'kernel', caller: 'kernel', entries, ...extra,
})
const invalid = (error: unknown) => error instanceof KernelError && error.code === 'INVALID'

describe('reversible journal fields', () => {
  it('roundtrips nested values, missing fields, nulls and whole arrays in both directions', () => {
    const values = [{}, { value: null }, { value: false }, { value: 0 }, { value: '' },
      { value: { a: 1, empty: {} } }, { value: { b: { c: 2 } } }, { value: [1, { a: true }, null] }]
    for (const before of values) for (const after of values) {
      const delta = computeFieldDeltas(before, after)
      assert.deepEqual(applyFieldDeltas(before, delta, 'to'), after)
      assert.deepEqual(applyFieldDeltas(after, delta, 'from'), before)
    }
  })

  it('replaces the containing image for literal dots, empty keys and unaddressable names', () => {
    for (const before of [{ 'a.b': 1 }, { '': null }, { 'a\0b': { value: 2 } }, { nested: { 'a.b': false } }]) {
      const after = { value: 'new', '#extra': { $type: 'test.extra', 'a.b': 2 } }
      const delta = computeFieldDeltas(before, after)
      assert.deepEqual(applyFieldDeltas(before, delta, 'to'), after)
      assert.deepEqual(applyFieldDeltas(after, delta, 'from'), before)
    }
  })

  it('owns changed values and leaves source images and deltas untouched during replay', () => {
    const before = { meta: { list: [1, 2] } }, after = { meta: { list: [3, 4] } }
    const delta = computeFieldDeltas(before, after)
    before.meta.list.push(9)
    after.meta.list.push(8)
    const replayed = applyFieldDeltas({ meta: { list: [1, 2] } }, delta, 'to')
    replayed.meta.list.push(7)
    assert.deepEqual(delta, { 'meta.list': { from: [1, 2], to: [3, 4] } })
    assert.deepEqual(applyFieldDeltas({ meta: { list: [3, 4] } }, delta, 'from'), { meta: { list: [1, 2] } })
  })
})

describe('journal images', () => {
  it('stores owned full images for creation, deletion and reconciliation', () => {
    const data = { list: [1, 2] }, image = node(1, data)
    const created = encodeJournalEntry(null, image), deleted = encodeJournalEntry(image, null)
    const reconciled = encodeReconciliation(image.$id, image.$path, image)
    data.list.push(3)
    const expected = node(1, { list: [1, 2] })
    assert.deepEqual(created, { entry: { id: 'item', path: '/item', change: { t: 'create', after: expected } }, changedBytes: 0 })
    assert.deepEqual(deleted, { entry: { id: 'item', path: '/item', change: { t: 'delete', before: expected } }, changedBytes: 0 })
    assert.deepEqual(reconciled.change, { t: 'reconcile', after: expected })
    assert.throws(() => encodeJournalEntry(null, null), invalid)
    assert.throws(() => encodeJournalEntry(image, node(2, {}, '/item', 'other')), invalid)
  })

  it('adds a full image only after cumulative delta bytes exceed the current node size', () => {
    const before = node(1, { payload: 'x'.repeat(1024), value: 1 }), after = node(2, { payload: before.payload, value: 2 })
    const deltaBytes = Buffer.byteLength(JSON.stringify(computeFieldDeltas(before, after)))
    const nodeBytes = Buffer.byteLength(JSON.stringify(after))
    const equal = encodeJournalEntry(before, after, nodeBytes - deltaBytes)
    assert.equal(equal.entry.change.t, 'update')
    assert.equal('after' in equal.entry.change, false)
    assert.equal(equal.changedBytes, nodeBytes)
    const exceeded = encodeJournalEntry(before, after, nodeBytes - deltaBytes + 1)
    assert.equal(exceeded.entry.change.t, 'update')
    assert.deepEqual('after' in exceeded.entry.change && exceeded.entry.change.after, after)
    assert.equal(exceeded.changedBytes, 0)
    const following = encodeJournalEntry(after, node(3, { payload: before.payload, value: 3 }), exceeded.changedBytes)
    assert.equal('after' in following.entry.change, false)
    assert.ok(following.changedBytes > 0 && following.changedBytes < nodeBytes)
  })

  it('reconstructs from the nearest full image, in either direction at an anchored update', () => {
    const first = node(1, { value: { old: true }, array: [1, 2] })
    const second = node(2, { value: null, array: [2, 3] })
    const third = node(3, { other: {} })
    const fourth = node(4, { value: 4 })
    const records = [record(1, [encodeJournalEntry(null, first).entry]),
      record(2, [encodeJournalEntry(first, second).entry]),
      record(3, [encodeJournalEntry(second, third, 100_000).entry]),
      record(4, [encodeJournalEntry(third, fourth).entry])]
    for (const [seq, before, after] of [[2, first, second], [3, second, third], [4, third, fourth]] as const) {
      assert.deepEqual(readJournalImages(records, { pos: position(seq), id: 'item' }), { before, after })
    }
    assert.deepEqual(readJournalImages(records.slice(2), { pos: position(3), id: 'item' }), { before: second, after: third })
  })

  it('reconstructs moves and deletion without changing identity or losing the prior position', () => {
    const before = node(1, { value: 1 }), after = node(2, { value: 2 }, '/moved')
    const moved = encodeJournalEntry(before, after)
    assert.equal(moved.entry.from, '/item')
    const records = [record(1, [encodeJournalEntry(null, before).entry]), record(2, [moved.entry]),
      record(3, [encodeJournalEntry(after, null).entry])]
    assert.deepEqual(readJournalImages(records, { pos: position(2), id: 'item' }), { before, after })
    assert.deepEqual(readJournalImages(records.slice(2), { pos: position(3), id: 'item' }), { before: after, after: null })
  })

  it('reports unknown reconciliation before-images and preserves known absence', () => {
    const first = node(1, { value: 1 }), third = node(3, { value: 3 })
    const records = [record(1, [encodeReconciliation('item', '/item', first)]),
      record(2, [encodeReconciliation('item', '/item', null)]),
      record(3, [encodeReconciliation('item', '/item', third)])]
    assert.deepEqual(readJournalImages(records, { pos: position(1), id: 'item' }), { before: 'unknown', after: first })
    assert.deepEqual(readJournalImages(records, { pos: position(2), id: 'item' }), { before: first, after: null })
    assert.deepEqual(readJournalImages(records, { pos: position(3), id: 'item' }), { before: null, after: third })
    assert.deepEqual(readJournalImages(compactJournal(records, position(1)), { pos: position(1), id: 'item' }), {
      before: 'unknown', after: first,
    })
  })

  it('fails loudly for absent addresses and delta records without a full image', () => {
    const before = node(1, { payload: 'x'.repeat(1024), value: 1 }), after = node(2, { payload: before.payload, value: 2 })
    const records = [record(2, [encodeJournalEntry(before, after).entry])]
    assert.throws(() => readJournalImages(records, { pos: position(1), id: 'item' }),
      (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND')
    assert.throws(() => readJournalImages(records, { pos: position(2), id: 'other' }),
      (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND')
    assert.throws(() => readJournalImages(records, { pos: position(2), id: 'item' }), invalid)
    assert.throws(() => compactJournal(records, position(2)), invalid)
  })
})

describe('journal compaction', () => {
  it('preserves every retained before and after through edits, moves, deletions and reconciliation', () => {
    const records: JournalCommit[] = []
    const first = node(1, { payload: 'x'.repeat(2048), value: 1 })
    records.push(record(1, [encodeJournalEntry(null, first).entry]))
    let previous = first, changedBytes = 0
    for (let seq = 2; seq <= 12; seq++) {
      const after = node(seq, { payload: first.payload, value: seq }, seq < 7 ? '/item' : '/moved')
      const encoded = encodeJournalEntry(previous, after, changedBytes)
      records.push(record(seq, [encoded.entry]))
      previous = after; changedBytes = encoded.changedBytes
    }
    records.push(record(13, [encodeReconciliation('item', '/moved', node(13, { value: 13 }, '/moved'))]))
    previous = node(13, { value: 13 }, '/moved')
    records.push(record(14, [encodeJournalEntry(previous, null).entry]))
    records.push(record(15, [encodeReconciliation('item', '/moved', null)]))
    records.push(record(16, [encodeJournalEntry(null, node(16)).entry]))
    const original = structuredClone(records)
    for (let cut = 1; cut <= records.length + 1; cut++) {
      const compacted = compactJournal(records, position(cut))
      assert.equal(compacted.length, Math.max(0, records.length - cut + 1))
      for (const retained of compacted) for (const entry of retained.entries) {
        const address = { pos: retained.pos, id: entry.id }
        assert.deepEqual(readJournalImages(compacted, address), readJournalImages(records, address))
      }
      assert.deepEqual(compactJournal(compacted, position(cut)), compacted)
    }
    assert.deepEqual(records, original)
  })

  it('anchors each identity independently and keeps empty commits and idempotency decisions', () => {
    const a = node(1, { payload: 'x'.repeat(1024), value: 1 }), b = node(1, { value: 1 }, '/other', 'other')
    const nextA = node(3, { payload: a.payload, value: 3 }), nextB = node(4, { value: 4 }, '/other', 'other')
    const decision = { opId: { epoch: 'intake', time: 1, nonce: 'nonce' }, requestHash: 'hash', outcome: { pos: position(2) } }
    const records = [record(1, [encodeJournalEntry(null, a).entry, encodeJournalEntry(null, b).entry]),
      record(2, [], { decision }), record(3, [encodeJournalEntry(a, nextA).entry]), record(4, [encodeJournalEntry(b, nextB).entry])]
    const compacted = compactJournal(records, position(2))
    assert.deepEqual(compacted[0], records[1])
    assert.deepEqual(readJournalImages(compacted, { pos: position(3), id: 'item' }), { before: a, after: nextA })
    assert.deepEqual(readJournalImages(compacted, { pos: position(4), id: 'other' }), { before: b, after: nextB })
  })

  it('keeps hundreds of small edits of a large node smaller than five node images', () => {
    const payload = 'x'.repeat(200 * 1024), first = node(1, { payload, counter: 1 })
    const records: JournalCommit[] = [record(1, [encodeJournalEntry(null, first).entry])]
    let previous = first, changedBytes = 0
    for (let seq = 2; seq <= 400; seq++) {
      const after = node(seq, { payload, counter: seq }), encoded = encodeJournalEntry(previous, after, changedBytes)
      records.push(record(seq, [encoded.entry]))
      previous = after; changedBytes = encoded.changedBytes
    }
    const size = Buffer.byteLength(JSON.stringify(records)), nodeBytes = Buffer.byteLength(JSON.stringify(first))
    assert.ok(size < 5 * nodeBytes)
    assert.equal(records.flatMap(commit => commit.entries).filter(entry => 'after' in entry.change).length, 1)
    const compacted = compactJournal(records, position(300))
    assert.ok(Buffer.byteLength(JSON.stringify(compacted)) < 2 * nodeBytes)
    assert.deepEqual(readJournalImages(compacted, { pos: position(400), id: 'item' }), {
      before: node(399, { payload, counter: 399 }), after: previous,
    })
  })
})
