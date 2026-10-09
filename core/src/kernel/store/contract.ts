import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { KernelError } from '#errors'
import { computeFieldDeltas } from '#kernel/journal'
import type { Budget, JournalEntry, Position, Store, StoreCommit, StoredNode } from '#kernel/types'

export interface StoreContractOptions {
  name: string
  crash(run: () => Promise<void>): Promise<void>
  recover?(store: Store): Store | Promise<Store>
}

export const scanBudget = (): Budget => ({ nodes: 1000, bytes: 8 * 1024 * 1024, exprWork: 10_000_000, deadline: Date.now() + 60_000 })
export const position = (seq: number): Position => ({ instance: 'test', epoch: 1, seq })
export const storedNode = (path: string, fields: Record<string, unknown> = {}): StoredNode => ({
  ...fields, $path: path, $id: `id:${path}`, $type: 'test.item', $pos: position(0),
})

type ImageCommit = StoreCommit & { readonly writes: readonly { readonly path: string; readonly node: StoredNode }[] }

export function storeCommit(seq: number, nodes: readonly StoredNode[], before: readonly StoredNode[] = [], writerEpoch = 1): ImageCommit {
  const pos = position(seq)
  const writes = nodes.map(node => ({ path: node.$path, node: { ...node, $pos: pos } }))
  const entries: JournalEntry[] = writes.map(({ node }) => {
    const prior = before.find(old => old.$id === node.$id)
    if (prior === undefined) return { id: node.$id, path: node.$path, change: { t: 'create', after: node } }
    const delta = computeFieldDeltas(prior, node)
    return { id: node.$id, path: node.$path, change: { t: 'update', delta, after: node } }
  })
  return { pos, writerEpoch, writes, record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel', entries } }
}

const errorCode = (code: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === code

export function runStoreContract(factory: () => Store | Promise<Store>, options: StoreContractOptions): void {
  describe(`Store contract: ${options.name}`, () => {
    let store: Store
    beforeEach(async () => { store = await factory() })
    const scan = () => store.scan({ range: { subtree: '/' }, budget: scanBudget() })

    it('reads empty ranges and exact nodes without requiring a stored parent', async () => {
      const empty = await scan()
      assert.deepEqual(empty.items, [])
      assert.equal(empty.next, undefined)
      await store.commit(storeCommit(1, [storedNode('/p/a'), storedNode('/p/a/x'), storedNode('/p/b')]))
      assert.deepEqual((await store.scan({ range: { node: '/p/a' }, budget: scanBudget() })).items.map(node => node.$path), ['/p/a'])
      assert.deepEqual((await store.scan({ range: { children: '/p' }, budget: scanBudget() })).items.map(node => node.$path), ['/p/a', '/p/b'])
      assert.deepEqual((await store.scan({ range: { subtree: '/p/a' }, budget: scanBudget() })).items.map(node => node.$path), ['/p/a', '/p/a/x'])
    })

    it('uses path order and exclusive cursors, with no duplicate or missing page members', async () => {
      await store.commit(storeCommit(1, ['/p/c', '/p/a', '/p/b', '/p/d'].map(path => storedNode(path))))
      const query = { range: { children: '/p' }, budget: scanBudget(), limit: 2 }
      const first = await store.scan(query)
      assert.deepEqual(first.items.map(node => node.$path), ['/p/a', '/p/b'])
      assert.ok(first.next)
      const second = await store.scan({ ...query, after: first.next })
      assert.deepEqual(second.items.map(node => node.$path), ['/p/c', '/p/d'])
      assert.equal(second.next, undefined)
      assert.deepEqual((await scan()).items.map(node => node.$path), [...first.items, ...second.items].map(node => node.$path))
    })

    it('filters with the shared expression language and sorts ties by path', async () => {
      await store.commit(storeCommit(1, [
        storedNode('/p/c', { score: 2 }), storedNode('/p/a', { score: 2 }), storedNode('/p/b', { score: 7 }),
      ]))
      const rows = await store.scan({ range: { children: '/p' }, where: { score: { $gte: 2 }, $type: 'test.item' },
        sort: [['score', -1]], budget: scanBudget(), limit: 2 })
      assert.deepEqual(rows.items.map(node => node.$path), ['/p/b', '/p/a'])
      assert.ok(rows.next)
      const rest = await store.scan({ range: { children: '/p' }, where: { score: { $gte: 2 }, $type: 'test.item' },
        sort: [['score', -1]], budget: scanBudget(), after: rows.next })
      assert.deepEqual(rest.items.map(node => node.$path), ['/p/c'])
    })

    it('refuses exhausted node, byte, expression and deadline budgets instead of truncating', async () => {
      await store.commit(storeCommit(1, [storedNode('/a', { value: 1 }), storedNode('/b', { value: 2 })]))
      for (const budget of [{ ...scanBudget(), nodes: 1 }, { ...scanBudget(), bytes: 1 }, { ...scanBudget(), deadline: 0 }]) {
        await assert.rejects(() => store.scan({ range: { subtree: '/' }, limit: 1, budget }), errorCode('BUDGET'))
      }
      await assert.rejects(() => store.scan({ range: { subtree: '/' }, where: { value: 1 }, budget: { ...scanBudget(), exprWork: 0 } }), errorCode('BUDGET'))
    })

    it('counts filtered-out nodes against the scan budget', async () => {
      await store.commit(
        storeCommit(1, [storedNode('/a', { value: 1 }), storedNode('/b', { value: 2 })]),
      )
      await assert.rejects(
        () =>
          store.scan({
            range: { subtree: '/' },
            where: { value: 99 },
            budget: { ...scanBudget(), nodes: 1 },
          }),
        errorCode('BUDGET'),
      )
    })

    it('deletes only the addressed node and keeps its descendants readable', async () => {
      const first = storeCommit(1, [storedNode('/p/a'), storedNode('/p/a/x'), storedNode('/p/b')])
      await store.commit(first)
      const deleted = first.writes[0].node
      const pos = position(2)
      await store.commit({ pos, writerEpoch: 1, writes: [{ path: deleted.$path, node: null }],
        record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel', entries: [
          { id: deleted.$id, path: deleted.$path, change: { t: 'delete', before: deleted } },
        ] },
      })
      assert.deepEqual((await store.scan({ range: { node: '/p/a' }, budget: scanBudget() })).items, [])
      assert.deepEqual((await store.scan({ range: { children: '/p' }, budget: scanBudget() })).items.map(node => node.$path), ['/p/b'])
      assert.deepEqual((await store.scan({ range: { subtree: '/p/a' }, budget: scanBudget() })).items.map(node => node.$path), ['/p/a/x'])
    })

    it('continues a sorted cursor after its anchor node is deleted', async () => {
      const first = storeCommit(1, [storedNode('/p/b', { score: 7 }), storedNode('/p/c', { score: 2 }), storedNode('/p/a', { score: 2 })])
      await store.commit(first)
      const query = { range: { children: '/p' }, sort: [['score', -1]] as const, budget: scanBudget(), limit: 1 }
      const page = await store.scan(query)
      assert.deepEqual(page.items.map(node => node.$path), ['/p/b'])
      assert.ok(page.next)
      const deleted = first.writes[0].node
      const pos = position(2)
      await store.commit({ pos, writerEpoch: 1, writes: [{ path: deleted.$path, node: null }],
        record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel', entries: [
          { id: deleted.$id, path: deleted.$path, change: { t: 'delete', before: deleted } },
        ] },
      })
      const next = await store.scan({ ...query, after: page.next })
      assert.deepEqual(next.items.map(node => node.$path), ['/p/a'])
      assert.ok(next.next)
      assert.deepEqual((await store.scan({ ...query, after: next.next })).items.map(node => node.$path), ['/p/c'])
    })

    it('rejects cursors reused with another range, filter or sort', async () => {
      await store.commit(storeCommit(1, [storedNode('/p/a'), storedNode('/p/b')]))
      const query = { range: { children: '/p' }, budget: scanBudget(), limit: 1 }
      const page = await store.scan(query)
      assert.ok(page.next)
      for (const changed of [{ ...query, range: { subtree: '/p' } }, { ...query, where: { $type: 'test.item' } },
        { ...query, sort: [['$path', -1]] as const }]) {
        await assert.rejects(() => store.scan({ ...changed, after: page.next }), errorCode('INVALID'))
      }
    })

    it('persists the matching journal and position with the data', async () => {
      const commit = storeCommit(1, [storedNode('/p/a')])
      await store.commit(commit)
      assert.deepEqual((await scan()).items[0].$pos, commit.pos)
      assert.deepEqual((await store.scan({ range: { journal: '/p' }, budget: scanBudget() })).items, [commit.record])
      assert.deepEqual((await store.scan({ range: { journal: '/other' }, budget: scanBudget() })).items, [])
      assert.deepEqual((await store.scan({ range: { journal: '/' , after: commit.pos }, budget: scanBudget() })).items, [])
    })

    it('pages the journal by position with an exclusive starting position', async () => {
      const records = [1, 2, 3].map(seq => storeCommit(seq, [storedNode(`/p/${seq}`)]))
      for (const record of records) await store.commit(record)
      const query = { range: { journal: '/p', after: position(1) }, budget: scanBudget(), limit: 1 }
      const first = await store.scan(query)
      assert.deepEqual(first.items, [records[1].record])
      assert.ok(first.next)
      const second = await store.scan({ ...query, after: first.next })
      assert.deepEqual(second.items, [records[2].record])
      assert.equal(second.next, undefined)
    })

    it('includes moves in the journal for both their old and new paths', async () => {
      const first = storeCommit(1, [storedNode('/old/a')])
      await store.commit(first)
      const before = first.writes[0].node
      const moved = storeCommit(2, [{ ...before, $path: '/new/a' }], [before])
      const record = { ...moved.record, entries: moved.record.entries.map(entry => ({ ...entry, from: before.$path })) }
      await store.commit({ ...moved, writes: [{ path: before.$path, node: null }, ...moved.writes], record })
      for (const path of ['/old', '/new']) {
        assert.deepEqual((await store.scan({ range: { journal: path, after: first.pos }, budget: scanBudget() })).items, [record])
      }
      assert.deepEqual((await scan()).items.map(node => node.$path), ['/new/a'])
    })

    it('rejects inconsistent writes before publishing any data or journal entries', async () => {
      const valid = storeCommit(1, [storedNode('/a')])
      const invalid: StoreCommit[] = [
        { ...valid, record: { ...valid.record, pos: position(9) } },
        { ...valid, writes: [{ path: '/other', node: valid.writes[0].node }] },
        { ...valid, writes: [{ path: '/a', node: { ...valid.writes[0].node, $pos: position(9) } }] },
        { ...valid, writes: [...valid.writes, ...valid.writes] },
      ]
      for (const commit of invalid) {
        await assert.rejects(() => store.commit(commit), errorCode('INVALID'))
        const empty = await scan()
        assert.deepEqual(empty.items, [])
        assert.equal(empty.next, undefined)
        assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [])
      }
    })

    it('keeps data and journal unchanged after an injected failure before journal publication', async () => {
      const original = storedNode('/p/a', { value: 1 })
      const first = storeCommit(1, [original])
      await store.commit(first)
      let attempted = false
      await assert.rejects(() => options.crash(async () => {
        attempted = true
        await store.commit(storeCommit(2, [storedNode('/p/a', { value: 2 }), storedNode('/p/b')], [first.writes[0].node]))
      }), Error)
      assert.equal(attempted, true)
      if (options.recover) store = await options.recover(store)
      assert.deepEqual((await scan()).items, first.writes.map(write => write.node))
      assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [first.record])
    })

    it('rejects an older writer epoch without leaving a partial write or record', async () => {
      await store.commit(storeCommit(1, [storedNode('/a')], [], 2))
      await assert.rejects(() => store.commit(storeCommit(2, [storedNode('/b')], [], 1)), errorCode('CONFLICT'))
      assert.deepEqual((await scan()).items.map(node => node.$path), ['/a'])
      assert.equal((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items.length, 1)
    })

    it('does not alias caller inputs or scan results', async () => {
      const value = { count: 1 }
      const node = storedNode('/a', { value })
      const commit = storeCommit(1, [node])
      await store.commit(commit)
      value.count = 9
      Reflect.set(commit.record, 'caller', 'external:changed')
      const first = (await scan()).items[0]
      assert.deepEqual(first.value, { count: 1 })
      Reflect.set(first, 'value', 'changed')
      assert.deepEqual((await scan()).items[0].value, { count: 1 })
      assert.equal((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items[0].caller, 'kernel')
    })

    it('records a decision-only commit and returns the latest matching decision', async () => {
      const opId = { epoch: 'intake', time: 1, nonce: 'nonce' }
      const first: StoreCommit = { ...storeCommit(1, []), record: { ...storeCommit(1, []).record,
        caller: 'u:alice', decision: { opId, requestHash: 'request' },
      } }
      const second: StoreCommit = { ...storeCommit(2, []), record: { ...first.record, pos: position(2),
        decision: { opId, requestHash: 'request', outcome: { value: 'done', pos: position(2) } },
      } }
      await store.commit(first)
      await store.commit(second)
      assert.deepEqual((await store.scan({ range: { decision: { caller: 'u:alice', opId } }, budget: scanBudget() })).items, [second.record])
      assert.deepEqual((await store.scan({ range: { decision: { caller: 'u:bob', opId } }, budget: scanBudget() })).items, [])
    })
  })
}
