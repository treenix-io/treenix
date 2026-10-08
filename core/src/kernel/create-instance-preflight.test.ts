import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import { createFsBlobStore } from '#kernel/blob-store-fs'
import { createInstance } from '#kernel/instance'
import { openPersistentWriter } from '#kernel/persistence'
import { createFsStore } from '#kernel/store/fs'
import { scanBudget } from '#kernel/store/contract'
import type { DecisionRange, InstanceConfig, JournalRange, ModuleManifest, ScanQuery, ScanRange, StoredNode } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Keeps every fixture inside project temp and uses an actual acquired writer and filesystem Store. */
async function setup() {
  const parent = fileURLToPath(new URL('../../../../temp/native-provisioning-contract/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'instance-'))
  const id = `preflight:${randomUUID()}`
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: id })
  const store = await createFsStore({ directory, lease })
  const blobs = await createFsBlobStore(join(directory, '.treenix', 'blobs'))
  const provisioning = { counter: lease, writerEpoch: lease.writerEpoch,
    domains: [{ store, epoch: lease.epoch, persistent: true }], credentialTtlMs: 60_000 }
  const fresh: InstanceConfig = { id, root: { kind: 'store', store }, blobs, modules: [],
    provisioning: { ...provisioning, bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'preflight-password' } } } }
  const reopen: InstanceConfig = { ...fresh, provisioning: { ...provisioning, bootstrap: { kind: 'reopen' } } }
  async function persisted() { return { counter: await lease.load(), journal: await readFile(join(directory, '.treenix', 'journal.log')) } }
  async function corrupt(path: string, field: string, value: unknown) {
    const node = (await store.scan({ range: { node: path }, budget: scanBudget() })).items[0]
    assert.ok(node)
    const current = await lease.load(); assert.ok(current)
    const pos = { ...current, seq: current.seq + 1 }
    await lease.save(pos, lease.writerEpoch)
    const after: StoredNode = structuredClone({ ...node, $pos: pos })
    Reflect.set(after, field, value)
    await store.commit({ pos, writerEpoch: lease.writerEpoch, writes: [{ path, node: after }],
      record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [{ id: node.$id, path,
        change: { t: 'update', after, delta: { [field]: { from: node[field], to: value } } } }] } })
  }
  return { fresh, reopen, store, lease, persisted, corrupt, async close() { await store.close(); await lease.close() } }
}

for (const invalid of [{ path: '/sys/limits', field: 'readNodes', value: -1, error: 'INVALID' as const },
  { path: '/sys/types/t.user', field: 'module', value: 'foreign-owner', error: 'FORBIDDEN' as const }]) {
  it(`refuses persisted ${invalid.field} corruption before fencing or reserving another position`, { timeout: 10000 }, async t => {
    const f = await setup(); t.after(f.close)
    const initial = await createInstance(f.fresh); initial.close()
    await f.corrupt(invalid.path, invalid.field, invalid.value)
    const before = await f.persisted()
    await assert.rejects(createInstance(f.reopen), code(invalid.error))
    assert.deepEqual(await f.persisted(), before)
    assert.equal((await f.store.scan({ range: { node: '/admin' }, budget: scanBudget() })).items.length, 1)
  })
}

it('rejects a reserved first-account path before accepting a fence in a wholly empty Store', { timeout: 10000 }, async t => {
  const f = await setup(); t.after(f.close)
  const before = await f.persisted()
  await assert.rejects(createInstance({ ...f.fresh, provisioning: { ...f.fresh.provisioning,
    bootstrap: { kind: 'fresh', admin: { path: '/sys/limits', name: 'admin', password: 'preflight-password' } } } }), code('INVALID'))
  assert.deepEqual(await f.persisted(), before)
  assert.deepEqual((await f.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
})

it('rejects an empty first-account name before accepting a fence or reserving a position', { timeout: 10000 }, async t => {
  const f = await setup(); t.after(f.close)
  const before = await f.persisted()
  await assert.rejects(createInstance({ ...f.fresh, provisioning: { ...f.fresh.provisioning,
    bootstrap: { kind: 'fresh', admin: { path: '/admin', name: '', password: 'preflight-password' } } } }), code('INVALID'))
  assert.deepEqual(await f.persisted(), before)
  assert.deepEqual((await f.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
})

it('refuses module ownership conflict at reopen before fencing the borrowed filesystem Store', { timeout: 10000 }, async t => {
  const f = await setup(); t.after(f.close)
  const module: ModuleManifest = { id: 'owner-one', types: [{ name: 'review.item', module: 'owner-one', version: 0,
    security: 'ordinary', schema: {}, actions: {} }], security: [], open: [] }
  const initial = await createInstance({ ...f.fresh, modules: [module] }); initial.close()
  const replacement: ModuleManifest = { ...module, id: 'owner-two', types: module.types.map(type => ({ ...type, module: 'owner-two' })) }
  const before = await f.persisted()
  await assert.rejects(createInstance({ ...f.reopen, modules: [replacement] }), code('FORBIDDEN'))
  assert.deepEqual(await f.persisted(), before)
  assert.equal((await f.store.scan({ range: { node: '/sys/types/review.item' }, budget: scanBudget() })).items[0].module, 'owner-one')
})

/** Holds the actual filesystem root read while caller-owned configuration changes. */
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('owns admin lifetime and domain inputs before an asynchronous filesystem preflight', { timeout: 10000 }, async t => {
  const f = await setup(); t.after(f.close)
  const entered = signal(), release = signal()
  t.after(() => release.resolve())
  const scan = f.store.scan.bind(f.store)
  let held = false
  const intercepted = t.mock.method(f.store, 'scan', async (query: ScanQuery<ScanRange | JournalRange | DecisionRange>) => {
    if (!held && 'node' in query.range && query.range.node === '/') {
      held = true; entered.resolve(); await release.promise
    }
    if ('journal' in query.range || 'decision' in query.range) return scan({ ...query, range: query.range })
    return scan({ ...query, range: query.range })
  })
  t.after(() => intercepted.mock.restore())
  const admin = { path: '/admin', name: 'before', password: 'preflight-password' }
  const domain = { store: f.store, epoch: f.lease.epoch, persistent: true }
  const provisioning = { counter: f.lease, writerEpoch: f.lease.writerEpoch, domains: [domain],
    credentialTtlMs: 60_000, bootstrap: { kind: 'fresh' as const, admin } }
  const opening = createInstance({ ...f.fresh, provisioning })
  await entered.promise
  admin.path = '/sys/limits'; admin.name = 'after'
  provisioning.credentialTtlMs = Number.NaN
  domain.epoch = ''
  Reflect.set(provisioning, 'bootstrap', { kind: 'reopen' })
  release.resolve()
  const instance = await opening
  t.after(() => instance.close())
  assert.equal(instance.bootstrap.adminPath, '/admin')
  assert.equal((await instance.source.node('/admin'))?.name, 'before')
  assert.equal(instance.writer.stream.cursor().epochs[f.store.domain], f.lease.epoch)
  const anonymous = await instance.openSession(); anonymous.close()
  assert.ok(anonymous.actor.principal.startsWith('anon:'))
})
