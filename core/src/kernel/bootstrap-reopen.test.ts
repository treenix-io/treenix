import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import { AUTH_KEY_PATH } from '#kernel/auth-module'
import { passwordPath } from '#kernel/auth/crypto'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { TYPE_PATH } from '#kernel/bootstrap'
import { optionalKernelTypes } from '#kernel/builtins'
import { createInstance } from '#kernel/instance'
import { openPersistentWriter } from '#kernel/persistence'
import { drainSession } from '#kernel/session-delivery'
import { createFsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import type { Frame, InstanceConfig, ModuleManifest, Pending, Position, PositionCounter, StoredNode } from '#kernel/types'

const admin = { path: '/admin', name: 'admin', password: 'compatibility-password' }
const module: ModuleManifest = { id: 'compatibility', types: [{ name: 'compatibility.counter', module: 'compatibility',
  security: 'ordinary', version: 0, schema: { type: 'object', properties: { count: { type: 'number' } } },
  actions: { increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } } } }], security: [], open: [] }

/** Preserve actual issued positions for an in-process borrowed root. */
function counter(): PositionCounter {
  let saved: Position | undefined
  return { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } }
}

/** Deliver the real pos/done channel before awaiting its Pending outcome. */
async function finish(frames: AsyncIterator<Frame>, pending: Pending): Promise<readonly Frame[]> {
  const delivered: Frame[] = []
  for (;;) {
    const frame = await frames.next()
    assert.equal(frame.done, false)
    delivered.push(frame.value)
    if (frame.value.t === 'done' && frame.value.req === pending.id) break
  }
  const outcome = await pending.outcome
  const pos = outcome.pos
  assert.ok(pos)
  assert.ok(delivered.some(frame => frame.t === 'pos' && frame.pos.seq === pos.seq))
  return delivered
}

/** Export a coherent earlier checkpoint that predates optional native ownership. */
async function olderCheckpoint() {
  const root = createMemoryStore({ domain: 'checkpoint-source' })
  const config: InstanceConfig = { id: 'compatibility', root: { kind: 'store', store: root }, blobs: createMemoryBlobStore(),
    modules: [module], provisioning: { writerEpoch: 1, counter: counter(), credentialTtlMs: 60_000,
      domains: [{ store: root, epoch: 'source', persistent: true }], bootstrap: { kind: 'fresh', admin } } }
  const instance = await createInstance(config)
  assert.ok(instance.setupCredential)
  const credential = instance.setupCredential
  const session = await instance.openSession(credential), delivery = drainSession(session)
  try {
    await session.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'old-counter' },
      changes: [{ op: 'put', node: { $path: '/counter', $type: 'compatibility.counter', count: 0 } }] }).outcome
    const rows = (await root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items
    const pos = instance.writer.position
    const optional = new Set(optionalKernelTypes.map(type => `${TYPE_PATH}/${type.name}`))
    const nodes: StoredNode[] = []
    for (const node of rows) if (!optional.has(node.$path)) nodes.push({ ...node, $pos: pos })
    return { nodes, pos, credential, adminId: instance.bootstrap.adminId }
  } finally {
    await instance.close(); await delivery; root.close()
  }
}

for (const mode of ['memory', 'fs'] as const) it(`reopens an older ${mode} checkpoint and installs optional ownership only through admin`, { timeout: 10_000 }, async t => {
  const checkpoint = await olderCheckpoint()
  const parent = fileURLToPath(new URL('../../../../temp/bootstrap-compatibility/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, `${mode}-`))
  let lease = mode === 'fs' ? await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'compatibility' }) : undefined
  let root = lease === undefined ? createMemoryStore({ domain: 'checkpoint-root' }) : await createFsStore({ directory, lease })
  t.after(async () => { await root.close(); await lease?.close() })
  const writerEpoch = lease?.writerEpoch ?? 1
  await root.commit({ pos: checkpoint.pos, writerEpoch, writes: checkpoint.nodes.map(node => ({ path: node.$path, node })),
    record: { pos: checkpoint.pos, kind: 'kernel', executor: 'kernel', caller: 'kernel',
      entries: checkpoint.nodes.map(node => ({ id: node.$id, path: node.$path, change: { t: 'create', after: node } })) } })
  if (lease !== undefined) {
    await root.close(); await lease.close()
    lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'compatibility' })
    root = await createFsStore({ directory, lease })
  }
  const config: InstanceConfig = { id: 'compatibility', root: { kind: 'store', store: root }, blobs: createMemoryBlobStore(),
    modules: [module], provisioning: { counter: lease ?? counter(), writerEpoch: lease?.writerEpoch ?? writerEpoch, credentialTtlMs: 60_000,
      domains: [{ store: root, epoch: lease?.epoch ?? 'checkpoint', persistent: true }], bootstrap: { kind: 'reopen' } } }
  const protectedPaths = ['/', AUTH_KEY_PATH, '/admin', passwordPath(checkpoint.adminId)]
  const protectedNodes = checkpoint.nodes.filter(node => protectedPaths.includes(node.$path))
  const reopened = await createInstance(config)
  try {
    assert.deepEqual((await root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, checkpoint.nodes)
    assert.equal(await reopened.source.node(`${TYPE_PATH}/t.mount.memory`), null)
    assert.throws(() => reopened.registry.type('t.mount.memory'),
      (error: unknown) => error instanceof KernelError && error.code === 'UNKNOWN_TYPE')
    const credential = await reopened.auth.login({ account: admin.path, password: admin.password })
    const session = await reopened.openSession(credential), frames = session.lane[Symbol.asyncIterator]()
    const welcome = await frames.next()
    assert.ok(!welcome.done && welcome.value.t === 'welcome')
    const sub = session.sub({ node: '/counter' })
    const snap = await frames.next()
    assert.ok(!snap.done && snap.value.t === 'snap' && snap.value.sub === sub)
    const actionFrames = await finish(frames, session.act({ path: '/counter', action: 'increment', args: {},
      opId: { epoch: reopened.writer.intake.epoch, time: Date.now(), nonce: 'old-action' } }))
    assert.ok(actionFrames.some(frame => frame.t === 'pos' && frame.changes.length > 0))
    await finish(frames, session.commit({ opId: { epoch: reopened.writer.intake.epoch, time: Date.now(), nonce: 'old-edit' },
      changes: [{ op: 'patch', path: '/counter', ops: { $set: { count: 2 } } }] }))
    assert.equal((await reopened.source.node('/counter'))?.count, 2)
    assert.equal(await reopened.source.node(`${TYPE_PATH}/t.mount.memory`), null)
    for (const node of protectedNodes) assert.deepEqual(await reopened.source.node(node.$path), node)
    session.unsub(sub)
    await frames.return?.()
  } finally { await reopened.close() }
  const installed = await createInstance({ ...config, provisioning: { ...config.provisioning,
    bootstrap: { kind: 'reopen', installerCredential: checkpoint.credential } } })
  try {
    assert.equal(installed.registry.type('t.mount.memory').security, 'user-capability')
    const owner = await installed.source.node(`${TYPE_PATH}/t.mount.memory`)
    assert.ok(owner)
    assert.equal(owner.module, 'kernel')
    const records = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const accepted = records.find(record => record.entries.some(entry => entry.path === owner.$path))
    assert.ok(accepted)
    assert.equal(accepted.executor, `u:${checkpoint.adminId}`)
    assert.equal(accepted.caller, `u:${checkpoint.adminId}`)
    for (const node of protectedNodes) assert.deepEqual(await installed.source.node(node.$path), node)
  } finally {
    await installed.close()
  }
})
