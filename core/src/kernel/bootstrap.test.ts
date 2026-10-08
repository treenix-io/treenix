import type { PositionCounter } from '#kernel/types'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { AUTH_KEY_PATH } from '#kernel/auth-module'
import { passwordPath, verifyPassword } from '#kernel/auth/crypto'
import { bootstrapModules, LIMITS_PATH, TYPE_PATH } from '#kernel/bootstrap'
import { createInstanceFoundation } from '#kernel/instance'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import { DEFAULT_LIMITS, type DecisionRange, type JournalCommit, type JournalRange, type Position,
  type ScanQuery, type ScanRange, type ScanResult, type Store, type StoredNode } from '#kernel/types'


const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const firstAdmin = { path: '/auth/users/first', name: 'first', password: 'first-test-password' }
function counter(initial?: Position): PositionCounter {
  let saved = initial, epoch = initial?.epoch ?? 0, lease = 0
  return { async load() { return saved }, async save(pos, writerEpoch) {
    if (writerEpoch < lease) throw new KernelError('CONFLICT', 'Stale counter lease')
    lease = writerEpoch; saved = { ...pos }
  }, async freshEpoch(floor) { epoch = Math.max(epoch, floor) + 1; return epoch } }
}
const options = (root: Store, saved = counter(), writerEpoch = 1) => ({ id: 'foundation-test', root,
  counter: saved, writerEpoch, domains: [{ store: root, epoch: 'root1', persistent: true }], budget: scanBudget })

describe('native instance bootstrap', { timeout: 10_000 }, () => {
  it('loads and bootstraps without registering legacy built-ins', () => {
    const script = `
      import assert from 'node:assert/strict'
      assert.equal(globalThis.__treenxCoreRegistry, undefined)
      await import('#kernel/builtins')
      assert.equal(globalThis.__treenxCoreRegistry, undefined)
      const legacy = await import('#core/registry')
      assert.equal(legacy.getRegistryVersion(), 0)
      const { createInstanceFoundation } = await import('#kernel/instance')
      const { createMemoryStore } = await import('#kernel/store/memory')
      assert.deepEqual(legacy.mapRegistry((type, context) => [type, context]), [])
      let saved
      const root = createMemoryStore({ domain: 'isolated' })
      const instance = await createInstanceFoundation({ id: 'isolated', root, writerEpoch: 1,
        counter: { load: async () => saved, save: async value => { saved = value }, freshEpoch: async floor => floor + 1 },
        domains: [{ store: root, epoch: 'isolated1', persistent: false }],
        firstAdmin: { path: '/admin', name: 'admin', password: 'isolated-password' } })
      assert.equal(instance.registry.type('t.dir').module, 'kernel')
      assert.equal(legacy.resolveExact('t.dir', 'schema'), null)
      assert.equal(legacy.getRegistryVersion(), 0)
      assert.deepEqual(legacy.mapRegistry((type, context) => [type, context]), [])
      process.stdout.write('isolated')
    `
    const output = execFileSync(process.execPath, ['--conditions=development', '--import', 'tsx', '--input-type=module', '--eval', script],
      { encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: undefined, VSCODE_INSPECTOR_OPTIONS: undefined } })
    assert.equal(output, 'isolated')
  })

  it('persists the generated first account, password, root, types, key and limits in one kernel commit', async () => {
    const root = createMemoryStore({ domain: 'bootstrap' })
    const instance = await createInstanceFoundation({ ...options(root), firstAdmin })
    const account = await instance.source.node(firstAdmin.path), owner = await instance.source.node('/')
    const password = await instance.source.node(passwordPath(instance.bootstrap.adminId))
    assert.ok(account && owner && password && typeof password.hash === 'string')
    assert.equal(account.$id, instance.bootstrap.adminId)
    assert.equal(owner.adminId, account.$id)
    assert.equal(owner.adminPath, account.$path)
    assert.deepEqual(account['#groups'], { $type: 't.groups', $v: 0, list: ['admins'] })
    assert.equal(password.accountId, account.$id)
    assert.equal(await verifyPassword(firstAdmin.password, password.hash), true)
    assert.equal(await verifyPassword('different-password', password.hash), false)
    const key = await instance.source.node(AUTH_KEY_PATH), limits = await instance.source.node(LIMITS_PATH)
    assert.ok(key && limits)
    assert.equal(key.instance, instance.id)
    assert.deepEqual(instance.limits(), DEFAULT_LIMITS)
    for (const [field, value] of Object.entries(DEFAULT_LIMITS)) assert.equal(limits[field], value)
    for (const module of bootstrapModules) for (const type of module.types) {
      const metadata = await instance.source.node(`${TYPE_PATH}/${type.name}`)
      assert.ok(metadata)
      assert.equal(metadata.module, module.id)
      assert.equal(metadata.security, type.security)
      assert.deepEqual(metadata.$pos, account.$pos)
    }
    const records = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const record = records.find(commit => commit.entries.some(entry => entry.id === account.$id))
    assert.ok(record)
    assert.equal(record.kind, 'kernel')
    assert.equal(record.executor, 'kernel')
    assert.equal(record.caller, 'kernel')
    for (const node of [owner, password, key, limits]) {
      assert.deepEqual(node.$pos, record.pos)
      assert.ok(record.entries.some(entry => entry.id === node.$id && entry.change.t === 'create'))
    }
    assert.equal(records.filter(commit => commit.entries.length !== 0).length, 1)
  })

  it('leaves no accepted nodes when the second native preparation fails', async () => {
    const root = createMemoryStore({ domain: 'failed-prepare' })
    const failure = new KernelError('BUDGET', 'Injected second preparation failure')
    let rootReads = 0
    function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
    function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
    async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
      const range = query.range
      if ('node' in range && range.node === '/' && ++rootReads === 2) throw failure
      if ('journal' in range || 'decision' in range) return root.scan({ ...query, range })
      return root.scan({ ...query, range })
    }
    const wrapped: Store = { ...root, scan }
    await assert.rejects(createInstanceFoundation({ ...options(wrapped), firstAdmin }), error => error === failure)
    assert.equal(rootReads, 2)
    assert.deepEqual((await root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
    assert.ok((await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items.every(record => record.entries.length === 0))
  })

  it('enforces one transition budget across both preparation phases', async () => {
    const root = createMemoryStore({ domain: 'combined-budget' })
    const path = '/' + Array.from({ length: DEFAULT_LIMITS.changeSet - 1 }, (_, index) => `level${index}`).join('/')
    await assert.rejects(createInstanceFoundation({ ...options(root), firstAdmin: { ...firstAdmin, path } }), code('BUDGET'))
    assert.deepEqual((await root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
  })

  it('leaves account and credential absent when the atomic Store commit fails', async () => {
    let records = 0
    const failure = new KernelError('BUDGET', 'Injected durable bootstrap failure')
    const root = createMemoryStore({ domain: 'failed-commit', beforeRecord() { if (++records === 2) throw failure } })
    await assert.rejects(createInstanceFoundation({ ...options(root), firstAdmin }), error => error === failure)
    assert.deepEqual((await root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
    assert.ok((await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items.every(record => record.entries.length === 0))
  })

  it('reopens persisted state, fences an old writer and advances after a lost counter', async () => {
    const root = createMemoryStore({ domain: 'reopen' }), saved = counter()
    const instance = await createInstanceFoundation({ ...options(root, saved), firstAdmin })
    const key = await instance.source.node(AUTH_KEY_PATH)
    const reopened = await createInstanceFoundation(options(root, saved, 2))
    assert.deepEqual(reopened.bootstrap, instance.bootstrap)
    assert.deepEqual(await reopened.source.node(AUTH_KEY_PATH), key)
    await assert.rejects(instance.commit([{ op: 'put', node: { $path: '/old', $type: 't.dir' } }],
      { executor: 'kernel', caller: 'kernel' }), code('CONFLICT'))
    const lost = await createInstanceFoundation(options(root, counter(), 3))
    assert.ok(lost.writer.position.epoch > reopened.writer.position.epoch)
    assert.deepEqual(lost.bootstrap, instance.bootstrap)
    assert.equal(await lost.source.node('/old'), null)
    await assert.rejects(createInstanceFoundation({ ...options(root, saved, 4), firstAdmin }), code('INVALID'))
  })

  it('rejects another instance identity before fencing the Store', async () => {
    const root = createMemoryStore({ domain: 'binding' }), config = options(root)
    const instance = await createInstanceFoundation({ ...config, firstAdmin })
    const records = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    await assert.rejects(createInstanceFoundation({ ...config, id: 'other-instance', writerEpoch: 99 }), code('INVALID'))
    assert.deepEqual((await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items, records)
    await instance.commit([{ op: 'put', node: { $path: '/still-writable', $type: 't.dir' } }], { executor: 'kernel', caller: 'kernel' })
    assert.ok(await instance.source.node('/still-writable'))
  })

  it('rejects missing or inconsistent system metadata on reopen instead of repairing it', async () => {
    const original = createMemoryStore({ domain: 'valid-state' })
    await createInstanceFoundation({ ...options(original), firstAdmin })
    const saved = (await original.scan({ range: { subtree: '/' }, budget: scanBudget() })).items
    const variants: readonly { readonly path: string; readonly change: (node: StoredNode) => StoredNode | null; readonly error: KernelError['code'] }[] = [
      { path: AUTH_KEY_PATH, change: node => ({ ...node, instance: 'another-instance' }), error: 'INVALID' },
      { path: AUTH_KEY_PATH, change: () => null, error: 'INVALID' },
      { path: LIMITS_PATH, change: node => ({ ...node, readNodes: Number.POSITIVE_INFINITY }), error: 'INVALID' },
      { path: `${TYPE_PATH}/t.user`, change: () => null, error: 'INVALID' },
      { path: `${TYPE_PATH}/t.user`, change: node => ({ ...node, module: 'foreign' }), error: 'FORBIDDEN' },
      { path: `${TYPE_PATH}/t.user`, change: node => ({ ...node, security: 'user-capability' }), error: 'FORBIDDEN' },
      { path: `${TYPE_PATH}/t.mount.memory`, change: node => ({ ...node, module: 'foreign' }), error: 'FORBIDDEN' },
      { path: `${TYPE_PATH}/t.mount.memory`, change: node => ({ ...node, security: 'ordinary' }), error: 'FORBIDDEN' },
    ]
    for (const variant of variants) {
      const restored = createMemoryStore({ domain: 'restored-state' }), nodes: StoredNode[] = []
      for (const original of saved) {
        const node = original.$path === variant.path ? variant.change(original) : original
        if (node !== null) nodes.push(node)
      }
      const pos = nodes[0].$pos
      await restored.commit({ pos, writerEpoch: 1, writes: nodes.map(node => ({ path: node.$path, node })),
        record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: nodes.map(node =>
          ({ id: node.$id, path: node.$path, change: { t: 'create', after: node } })) } })
      await assert.rejects(createInstanceFoundation(options(restored, counter(), 2)), code(variant.error))
      assert.deepEqual((await restored.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, nodes)
    }
  })
})
