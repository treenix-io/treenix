import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it, type TestContext } from 'node:test'

import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import { openNativeRuntime, type NativeRuntimeConfig } from '#kernel/runtime'
import { drainSession } from '#kernel/session-delivery'
import { scanBudget } from '#kernel/store/contract'
import { R, W, type Frame, type ModuleManifest, type Node, type Session } from '#kernel/types'
import { isRecord } from '#util/is-record'

const module: ModuleManifest = {
  id: 'runtime-mounted-document',
  types: [{ name: 'runtime.mounted-document', module: 'runtime-mounted-document', security: 'ordinary',
    version: 0, schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
    actions: { increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } } } }],
  security: [], open: [],
}
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected

/** Makes unexpected lane termination fail at the delivery point. */
async function nextFrame(iterator: AsyncIterator<Frame>): Promise<Frame> {
  const item = await iterator.next()
  assert.equal(item.done, false)
  assert.ok(item.value)
  return item.value
}

/** Uses the public reader and preserves a schema failure as a test failure. */
async function readNode(session: Session, path: string): Promise<Node> {
  const result = await session.read({ node: path })
  assert.equal(result.copies.length, 1)
  const copy = result.copies[0]
  assert.ok('node' in copy)
  return copy.node
}

/** Boots a persistent root and seeds the host capability through the same native Session as callers. */
async function setup(t: TestContext, twoTargets = false) {
  const parent = resolve('../../temp/k26-runtime-fs')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'instance-'))
  const data = join(directory, 'host-data')
  const archive = join(directory, 'host-archive')
  await mkdir(data)
  await writeFile(join(data, 'doc.json'), JSON.stringify({ $type: 'runtime.mounted-document', count: 1 }))
  if (twoTargets) {
    await mkdir(archive)
    await writeFile(join(archive, 'doc.json'), JSON.stringify({ $type: 'runtime.mounted-document', count: 10 }))
  }
  const mountDirectories: Readonly<Record<string, string>> = twoTargets ? { data, archive } : { data }
  const input = { id: `runtime-fs-${randomUUID()}`, directory: join(directory, 'root'),
    credentialTtlMs: 60_000, modules: [module], mountDirectories,
    firstAdmin: { path: '/admin', name: 'admin', password: 'runtime-mount-password' } }
  const runtimes: Awaited<ReturnType<typeof openNativeRuntime>>[] = []
  const deliveries: Promise<void>[] = []
  t.after(async () => {
    for (const runtime of runtimes.reverse()) await runtime.close()
    await Promise.all(deliveries)
  })

  /** Registers only successful runtimes for ordered native resource release. */
  async function open(config: NativeRuntimeConfig = input) {
    const runtime = await openNativeRuntime(config)
    runtimes.push(runtime)
    return runtime
  }

  const first = await open()
  assert.equal(first.instance.registry.type('t.mount.fs').security, 'privileged-capability')
  assert.ok(first.instance.setupCredential)
  const credential = first.instance.setupCredential
  const admin = await first.instance.openSession(credential)
  deliveries.push(drainSession(admin))
  let nonce = 0
  const key = () => ({ epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: `seed-${nonce++}` })
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/work', $type: 't.dir',
      $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
    { op: 'put', node: { $path: '/data', $type: 't.dir',
      '#mount': { $type: 't.mount.fs', pattern: '', directory: 'data', external: 'none' },
      '#groups': { $type: 't.groups', list: ['admins'] } } },
    ...(twoTargets ? [{ op: 'put' as const, node: { $path: '/archive', $type: 't.dir',
      '#mount': { $type: 't.mount.fs', pattern: '', directory: 'archive', external: 'none' },
      '#groups': { $type: 't.groups', list: ['admins'] } } }] : []),
  ] }).outcome
  assert.equal((await readNode(admin, '/data'))['#mount'].directory, 'data')
  await assert.rejects(admin.read({ node: '/data/doc' }), code('UNAVAILABLE'))
  assert.deepEqual(await readdir(data), ['doc.json'])
  await first.close()

  /** Drains real completion delivery for mutation sessions whose lane is hidden by this fixture. */
  async function adminSession(runtime: Awaited<ReturnType<typeof openNativeRuntime>>) {
    const session = await runtime.instance.openSession(credential)
    deliveries.push(drainSession(session))
    return session
  }

  return { input, data, archive, credential, open, adminSession }
}

describe('kernel-owned persistent filesystem mounts', { timeout: 30_000 }, () => {
  it('uses named host capabilities for real Session reads, changes, watch and retained decision replay', async t => {
    const f = await setup(t)
    const runtime = await f.open()
    const admin = await f.adminSession(runtime)
    const original = await readNode(admin, '/data/doc')
    assert.equal(original.$id, 'p:/data/doc')
    assert.equal(original.count, 1)

    const visitor = await runtime.instance.openSession()
    const visitorDelivery = drainSession(visitor)
    await assert.rejects(visitor.commit({ opId: { epoch: runtime.instance.writer.intake.epoch,
      time: Date.now(), nonce: 'unprivileged-declaration' }, changes: [
      { op: 'put', node: { $path: '/work/forbidden', $type: 't.dir',
        '#mount': { $type: 't.mount.fs', pattern: '', directory: 'data' } } },
    ] }).outcome, code('FORBIDDEN'))
    visitor.close()
    await visitorDelivery
    await assert.rejects(admin.read({ node: '/work/forbidden' }), code('NOT_FOUND'))

    const watch = await runtime.instance.openSession(f.credential)
    const frames = watch.lane[Symbol.asyncIterator]()
    assert.equal((await nextFrame(frames)).t, 'welcome')
    watch.sub({ node: '/data/doc' })
    const snap = await nextFrame(frames)
    assert.ok(snap.t === 'snap')
    assert.deepEqual(snap.list, [original.$id])
    const opId = { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: 'persistent-increment' }
    const edited = await admin.commit({ opId: { ...opId, nonce: 'edit' }, changes: [
      { op: 'patch', path: '/data/doc', ops: { $set: { count: 5 } } },
    ] }).outcome
    assert.ok(edited.pos)
    const changed = await nextFrame(frames)
    assert.ok(changed.t === 'pos' && changed.coverage !== true)
    assert.ok(comparePositions(changed.pos, edited.pos) >= 0)
    assert.ok(changed.changes.some(change => change.op === 'patch' && change.id === original.$id
      || change.op === 'put' && 'node' in change.copy && change.copy.node.$id === original.$id))
    watch.close()
    const request = { path: '/data/doc', action: 'increment', args: {}, opId }
    const outcome = await admin.act(request).outcome
    assert.ok(outcome.pos)
    assert.equal((await readNode(admin, '/data/doc')).count, 6)
    const history = await admin.read({ history: '/data' })
    assert.ok(history.history?.some(entry => entry.address.id === original.$id
      && entry.opId?.nonce === opId.nonce && entry.after?.count === 6))
    const physical: unknown = JSON.parse(await readFile(join(f.data, 'doc', '$'), 'utf8'))
    assert.ok(isRecord(physical))
    assert.equal(physical.count, 6)
    assert.equal(physical.$id, undefined)
    assert.equal(physical.$path, undefined)
    await runtime.close()

    const reopened = await f.open()
    const replay = await f.adminSession(reopened)
    assert.deepEqual(await replay.act(request).outcome, outcome)
    assert.equal((await readNode(replay, '/data/doc')).count, 6)
    assert.equal((await readNode(replay, '/data/doc')).$id, original.$id)
  })

  it('refuses a missing named directory at startup and releases the root for a valid reopen', async t => {
    const f = await setup(t)
    await assert.rejects(f.open({ ...f.input, mountDirectories: {} }), code('UNAVAILABLE'))
    assert.deepEqual(await readdir(f.data), ['doc.json'])
    const runtime = await f.open()
    assert.equal((await readNode(await f.adminSession(runtime), '/data/doc')).count, 1)
  })

  it('refuses foreign filesystem type ownership before acquiring the approved target directory', async t => {
    const f = await setup(t)
    const foreign: ModuleManifest = { id: 'foreign-filesystem', types: [
      { name: 't.mount.fs', module: 'foreign-filesystem', security: 'privileged-capability',
        version: 0, schema: {}, actions: {} },
    ], security: [], open: [] }
    await assert.rejects(f.open({ ...f.input, modules: [module, foreign] }), code('FORBIDDEN'))
    assert.deepEqual(await readdir(f.data), ['doc.json'])
    const runtime = await f.open()
    assert.equal((await readNode(await f.adminSession(runtime), '/data/doc')).$id, 'p:/data/doc')
  })

  it('keeps two named namespaces independent and refuses an atomic write spanning both owners', async t => {
    const f = await setup(t, true)
    const runtime = await f.open()
    const admin = await f.adminSession(runtime)
    const data = await readNode(admin, '/data/doc')
    const archive = await readNode(admin, '/archive/doc')
    assert.equal(data.$id, 'p:/data/doc')
    assert.equal(archive.$id, 'p:/archive/doc')
    await assert.rejects(admin.commit({ opId: { epoch: runtime.instance.writer.intake.epoch,
      time: Date.now(), nonce: 'mixed-owner' }, changes: [
      { op: 'patch', path: '/data/doc', ops: { $inc: { count: 1 } } },
      { op: 'patch', path: '/archive/doc', ops: { $inc: { count: 1 } } },
    ] }).outcome, code('CROSS_DOMAIN'))
    assert.equal((await readNode(admin, '/data/doc')).count, 1)
    assert.equal((await readNode(admin, '/archive/doc')).count, 10)
    const records = (await runtime.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    assert.ok(records.some(record => record.intake !== undefined
      && Object.keys(record.intake.domains).length === 3))
  })
})
