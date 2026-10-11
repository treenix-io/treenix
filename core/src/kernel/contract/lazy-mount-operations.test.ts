import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it } from 'node:test'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import { storeCommit } from '#kernel/store/contract'
import { R, type ModuleManifest, type Position, type StoredNode } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Open genuine lazy targets; failed and stalled targets retain their declared ownership. */
async function fixture(onOpen?: (path: string) => Promise<void>) {
  const id = randomUUID(), root = createMemoryStore({ domain: id }), blobs = createMemoryBlobStore()
  const ref = await blobs.put('lazy-binary', (async function* () { yield new Uint8Array([1, 2, 3]) })(), 'application/octet-stream')
  const opened: string[] = []
  let release: () => void = () => {}
  const stalled = new Promise<void>(resolve => { release = resolve })
  function node(path: string): StoredNode {
    return { $path: `${path}/file`, $id: `file:${path}`, $type: 't.dir', $pos: { instance: id, epoch: 0, seq: 1 }, value: 7, file: ref }
  }
  const module: ModuleManifest = { id: 'lazy-operations', types: [
    { name: 'lazy.mount', module: 'lazy-operations', security: 'privileged-capability', version: 0, schema: {}, actions: {} },
    { name: 'lazy.actions', module: 'lazy-operations', security: 'ordinary', version: 0, schema: {}, actions: {
      read: { kind: 'read', args: {}, async handler() { return 1 } },
      increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } },
      needs: { kind: 'read', args: {}, needs: { file: { node: '/needed/file' } }, async handler(ctx) { return ctx.needs.file.list.length } },
      dynamic: { kind: 'read', args: {}, async handler(ctx) { return (await ctx.read.read({ node: '/dynamic/file' })).list.length } },
      denied: { kind: 'read', args: {}, async handler(ctx) { return ctx.read.read({ node: '/denied/file' }) } },
      unavailable: { kind: 'read', args: {}, async handler(ctx) { return ctx.read.read({ node: '/failed/file' }) } },
      destination: { kind: 'write', args: {}, async handler(ctx) {
        await ctx.requireReadWrite('/destination/new')
        ctx.change.put({ $path: '/destination/new', $type: 't.dir', value: 9 })
      } },
      stream: { kind: 'read', args: {}, async *handler(ctx) {
        yield (await ctx.read.read({ node: '/stream-first/file' })).list.length
        return (await ctx.read.read({ node: '/stream-next/file' })).list.length
      } },
    } },
  ], security: [{ type: 'lazy.mount', context: 'mount', async handler(declaration) {
    const path = declaration.$path
    opened.push(path)
    await onOpen?.(path)
    if (path === '/failed') throw new KernelError('UNAVAILABLE', 'Target is unavailable')
    if (path === '/stalled') { await stalled; throw new KernelError('UNAVAILABLE', 'Target is stalled') }
    const store = createMemoryStore({ domain: path })
    await store.commit(storeCommit(1, [node(path)]))
    return { kind: 'store', store, resources: { writerEpoch: 1, epoch: randomUUID(), persistent: false, decisionHistory: 'fresh' }, async close() { store.close() } }
  } }], open: [] }
  let saved: Position | undefined
  const instance = await createInstance({ id, root: { kind: 'store', store: root }, modules: [module], blobs,
    provisioning: { counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
      writerEpoch: 1, domains: [{ store: root, epoch: randomUUID(), persistent: false }], credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'lazy-mount-password' } } } })
  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential), drain = drainSession(admin)
  let nonce = 0
  const key = () => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: `lazy:${nonce++}` })
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/worker', $type: 'lazy.actions', count: 0 } },
    ...['failed', 'stalled', 'needed', 'dynamic', 'destination', 'stream-first', 'stream-next', 'denied', 'download'].map(name => ({
      op: 'put' as const, node: { $path: `/${name}`, $type: 't.dir', '#mount': { $type: 'lazy.mount', pattern: '' },
        ...(name === 'denied' ? { $acl: [{ subject: { group: 'public' }, grant: 0 }] }
          : { $acl: [{ subject: { group: 'public' }, grant: R }] }) },
    })),
  ] }).outcome
  return { instance, admin, opened, key, module, async close() { release(); await instance.close(); await drain; root.close() } }
}

it('executes healthy actions while unrelated targets are failed or unopened and stalled', { timeout: 10_000 }, async t => {
  const f = await fixture(); t.after(f.close)
  await assert.rejects(f.admin.read({ node: '/failed/file' }), code('UNAVAILABLE'))
  const failures = f.opened.filter(path => path === '/failed').length
  assert.equal((await f.admin.act({ path: '/worker', action: 'read', args: {} }).outcome).value, 1)
  await f.admin.act({ path: '/worker', action: 'increment', args: {}, opId: f.key() }).outcome
  const copy = (await f.admin.read({ node: '/worker' })).copies[0]
  assert.ok('node' in copy)
  assert.equal(copy.node.count, 1)
  assert.equal(f.opened.filter(path => path === '/failed').length, failures)
  assert.equal(f.opened.includes('/stalled'), false)
})

it('prepares actual declared needs, dynamic reads, authorization destinations and resumed stream reads', { timeout: 10_000 }, async t => {
  const f = await fixture(); t.after(f.close)
  for (const action of ['needs', 'dynamic'])
    assert.equal((await f.admin.act({ path: '/worker', action, args: {} }).outcome).value, 1)
  await f.admin.act({ path: '/worker', action: 'destination', args: {}, opId: f.key() }).outcome
  const destination = (await f.admin.read({ node: '/destination/new' })).copies[0]
  assert.ok('node' in destination)
  assert.equal(destination.node.value, 9)
  const stream = f.admin.act({ path: '/worker', action: 'stream', args: {} })
  const data = []
  for await (const piece of stream.chunks) data.push(piece)
  assert.deepEqual(data, [1])
  assert.equal((await stream.outcome).value, 1)
  assert.deepEqual(new Set(f.opened), new Set(['/needed', '/dynamic', '/destination', '/stream-first', '/stream-next']))
  await assert.rejects(f.admin.act({ path: '/worker', action: 'unavailable', args: {} }).outcome, code('UNAVAILABLE'))
})

it('downloads through a visible field as the first operation on an unopened mount', { timeout: 10_000 }, async t => {
  const f = await fixture(); t.after(f.close)
  const visitor = await f.instance.openSession()
  const parts: Uint8Array[] = []
  for await (const part of visitor.download('/download/file', 'file')) parts.push(part)
  assert.deepEqual([...Buffer.concat(parts)], [1, 2, 3])
  assert.deepEqual(f.opened, ['/download'])
  await assert.rejects((async () => {
    for await (const _part of visitor.download('/denied/file', 'file')) assert.fail('Hidden binary content was delivered')
  })(), code('NOT_FOUND'))
  assert.equal(f.opened.includes('/failed'), false)
})


it('follows a projected reference into its lazy target without opening unrelated failed or stalled mounts', { timeout: 10_000 }, async t => {
  const f = await fixture(); t.after(f.close)
  await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/reference', $type: 't.dir', target: '/needed/file' } }] }).outcome
  const result = await f.admin.read({ node: '/reference', include: [{ ref: 'target' }] })
  assert.deepEqual(result.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path), ['/reference', '/needed/file'])
  assert.deepEqual(f.opened, ['/needed'])
})


it('keeps explicit includes independent of reference preparation across sequential action reads', { timeout: 10_000 }, async t => {
  const f = await fixture(); t.after(f.close)
  const module: ModuleManifest = { ...f.module, types: f.module.types.map(type => type.name === 'lazy.actions' ? { ...type, actions: {
    ...type.actions, references: { kind: 'read', args: {}, async handler(ctx) {
      const ref = { node: '/reference', include: [{ ref: 'target' }] }, fixed = { node: '/reference', include: [{ path: '/dynamic/file' }] }
      const paths = []
      for (const selector of [ref, fixed, fixed, ref]) {
        const result = await ctx.read.read(selector)
        paths.push(result.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path))
      }
      return paths
    } },
  } } : type) }
  f.instance.registry.publish(module)
  await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/reference', $type: 't.dir', target: '/needed/file' } }] }).outcome
  const result = await f.admin.act({ path: '/worker', action: 'references', args: {} }).outcome
  assert.deepEqual(result.value, [['/reference', '/needed/file'], ['/dynamic/file', '/reference'], ['/dynamic/file', '/reference'], ['/reference', '/needed/file']])
  assert.deepEqual(f.opened, ['/needed', '/dynamic'])
})

it('leaves nested fixed includes unopened when their projected reference parent is missing or hidden', { timeout: 10_000 }, async t => {
  const f = await fixture(); t.after(f.close)
  await f.admin.commit({ opId: f.key(), changes: [
    { op: 'put', node: { $path: '/reference', $type: 't.dir', target: '/missing', $acl: [{ subject: { group: 'public' }, grant: R }] } },
    { op: 'put', node: { $path: '/hidden', $type: 't.dir', target: '/needed/file', $acl: [{ subject: { group: 'public' }, grant: 0 }] } },
  ] }).outcome
  const visitor = await f.instance.openSession()
  const result = await visitor.read({ node: '/reference', include: [{ ref: 'target', then: [{ path: '/failed/file' }] }] })
  assert.equal(result.copies.length, 1)
  await assert.rejects(visitor.read({ node: '/hidden', include: [{ ref: 'target', then: [{ path: '/failed/file' }] }] }), code('NOT_FOUND'))
  assert.deepEqual(f.opened, [])
})

it('refuses a reference changed while its admitted target is opening and never opens the replacement under Writer', { timeout: 10_000 }, async t => {
  let entered: () => void = () => {}, release: () => void = () => {}
  const opening = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  const f = await fixture(async path => { if (path === '/needed') { entered(); await held } })
  t.after(async () => { release(); await f.close() })
  await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/reference', $type: 't.dir', target: '/needed/file' } }] }).outcome
  const pending = assert.rejects(f.admin.read({ node: '/reference', include: [{ ref: 'target' }] }), code('CONFLICT'))
  await opening
  await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/reference', ops: { $set: { target: '/dynamic/file' } } }] }).outcome
  release(); await pending
  assert.deepEqual(f.opened, ['/needed'])
})
