import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isChildPath } from '#core/path'
import { KernelError } from '#errors'
import { createChainIndex, type ChainInput } from '#kernel/chain-index'
import { createInstanceFoundation } from '#kernel/instance'
import { createReader } from '#kernel/reader'
import { checkPreconditions } from '#kernel/preconditions'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import { DEFAULT_LIMITS, R, type ChangeMember, type Limits, type ModuleManifest, type Path, type Position, type Store } from '#kernel/types'
import type { PositionCounter } from '#kernel/writer'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const kernel = { executor: 'kernel', caller: 'kernel' } as const
const put = (path: Path, fields: Record<string, unknown> = {}): ChangeMember => ({ op: 'put', node: { $path: path, $type: 'test.item', ...fields } })

async function setup() {
  const raw = createMemoryStore({ domain: 'reader' }), index = createChainIndex(), paths = new Map<string, string>()
  function install(node: ChainInput): void {
    index.put(node); paths.set(node.$path, node.$id)
  }
  const store: Store = { ...raw, async commit(input) {
    await raw.commit(input)
    for (const write of input.writes) {
      if (write.node !== null) install(write.node)
      else { index.remove(write.path); paths.delete(write.path) }
    }
  } }
  let saved: Position | undefined
  const counter: PositionCounter = { load: async () => saved, save: async value => { saved = value }, freshEpoch: async floor => floor + 1 }
  const instance = await createInstanceFoundation({ id: 'reader-instance', root: store, writerEpoch: 1,
    domains: [{ store, epoch: 'reader-store', persistent: false }], counter,
    initialCredential: { ttlMs: 100_000 },
    firstAdmin: { path: '/auth/users/admin', name: 'admin', password: 'test-reader-password' } })
  const module: ModuleManifest = { id: 'reader-test', types: [
    { name: 'test.item', module: 'reader-test', security: 'ordinary', version: 0, schema: {}, actions: {} },
    { name: 'test.typed', module: 'reader-test', security: 'ordinary', version: 0,
      schema: { type: 'object', required: ['score'], properties: { score: { type: 'number' } } }, actions: {} },
  ], security: [], open: [] }
  await instance.commit(module.types.map(type => ({ op: 'put', node: { $path: `/sys/types/${type.name}`, $type: 't.type',
    name: type.name, module: type.module, security: type.security } })), kernel)
  instance.registry.publish(module)
  const auth = instance.auth
  const target = { id: 'reader-root', store, chain: index.chain, children: index.children }
  const bound = {
    async node(path: Path) {
      const lease = await instance.writer.cache.fill(store, { node: path }, scanBudget())
      try { return lease.nodes[0] ?? null } finally { lease.release() }
    },
    async nodeById(id: string) {
      for (const [path, found] of paths) if (found === id) return bound.node(path)
      return null
    },
    shard: () => false,
  }
  const source = { domains: [store.domain], auth: bound, resolve: () => target }
  assert.ok(instance.setupCredential)
  const admin = await auth.openCredential(instance.setupCredential)
  const anonymous = await auth.openCredential()
  const reader = (admission = anonymous, budget = scanBudget(), limits: Partial<Limits> = {}) => createReader({ registry: instance.registry,
    writer: instance.writer, admission, source, budget, limits: { ...DEFAULT_LIMITS, ...limits }, alert: () => {} })
  return { instance, auth, admin, anonymous, reader, source, target, store, index, module,
    commit: (changes: readonly ChangeMember[]) => instance.commit(changes, kernel) }
}

describe('native Reader contract', () => {
  it('prunes hidden children before payload budgets and makes hidden nodes indistinguishable from absence', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/list'), put('/list/visible', { score: 1, $acl: [{ subject: { group: 'public' }, grant: R }] }),
      ...Array.from({ length: 20 }, (_, i) => put(`/list/hidden-${i}`, { payload: 'x'.repeat(1000) }))])
    const read = f.reader(f.anonymous, { ...scanBudget(), nodes: 1, bytes: 512 })
    const result = await read.read({ children: '/list' })
    assert.equal(result.copies.length, 1)
    assert.ok('node' in result.copies[0])
    assert.equal(result.copies[0].node.$path, '/list/visible')
    assert.equal(result.copies[0].node.$acl, undefined)
    assert.equal(result.copies[0].bits, R)
    for (const path of ['/list/hidden-0', '/list/absent']) await assert.rejects(f.reader().read({ node: path }), code('NOT_FOUND'))
  })

  it('projects before filtering and sorting, then applies selector-bound exclusive windows', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    const acl = [{ subject: { group: 'public' }, grant: R }] as const
    await f.commit([put('/list', { $acl: acl }), put('/list/a', { score: 2, $order: 'a' }),
      put('/list/b', { score: 7, $order: 'b' }), put('/list/c', { score: 2, $order: 'c' }),
      put('/list/hidden', { score: 999, $acl: [{ subject: { group: 'public' }, deny: R }] })])
    const query = { children: '/list', where: { score: { $gte: 2 } }, sort: [['score', -1]], window: { limit: 1 } } as const
    const first = await f.reader().read(query)
    assert.equal(first.list.length, 1); assert.ok(first.next)
    assert.ok('node' in first.copies[0]); assert.equal(first.copies[0].node.$path, '/list/b')
    await f.commit([{ op: 'remove', path: '/list/b' }])
    const next = await f.reader().read({ ...query, window: { ...query.window, after: first.next } })
    assert.ok('node' in next.copies[0]); assert.equal(next.copies[0].node.$path, '/list/a')
    assert.ok(next.next)
    await assert.rejects(f.reader().read({ ...query, where: { score: 7 }, window: { limit: 1, after: first.next } }), code('INVALID'))
    const plain = await f.reader().read({ children: '/list' })
    assert.deepEqual(plain.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path), ['/list/a', '/list/c'])
  })

  it('shares node and expression budgets across includes and subsequent reads without truncation', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/list', { $acl: [{ subject: { group: 'public' }, grant: R }] }),
      put('/list/a', { score: 1, link: '/list/b' }), put('/list/b', { score: 2, link: '/list/c' }), put('/list/c', { score: 3 })])
    await assert.rejects(f.reader(f.anonymous, { ...scanBudget(), nodes: 1 }).read({ node: '/list/a', include: [{ ref: 'link' }] }), code('BUDGET'))
    const read = f.reader(f.anonymous, { ...scanBudget(), nodes: 1 })
    assert.equal((await read.read({ node: '/list/a' })).list.length, 1)
    await assert.rejects(read.read({ node: '/list/b' }), code('BUDGET'))
    await assert.rejects(f.reader(f.anonymous, { ...scanBudget(), exprWork: 1 }).read({ children: '/list', where: { score: { $gt: 0 } } }), code('BUDGET'))
    const shared = f.reader(f.anonymous, { ...scanBudget(), exprWork: 100 })
    const query = { children: '/list', where: { score: { $gt: 0 } } }
    assert.equal((await shared.read(query)).list.length, 3)
    await assert.rejects(async () => { for (let i = 0; i < 100; i++) await shared.read(query) }, code('BUDGET'))
    const included = await f.reader().read({ node: '/list/a', include: [{ ref: 'link', then: [{ ref: 'link' }] }] })
    assert.equal(included.list.length, 1)
    assert.deepEqual(included.copies.map(copy => 'node' in copy ? copy.node.$path : copy.path), ['/list/a', '/list/b', '/list/c'])
    const expect = f.reader(f.anonymous, scanBudget())
    await expect.read({ node: '/list/a', include: [{ path: '/hidden' }] })
    assert.ok(expect.expect().absent?.includes('/hidden'))
  })

  it('tracks semantic actor, target, chain, type, absence, selector and published-position dependencies', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/list', { $acl: [{ subject: { group: 'public' }, grant: R }] }), put('/list/a', { score: 1 })])
    const read = f.reader()
    const result = await read.read({ children: '/list', where: { score: 1 }, include: [{ path: '/missing' }] })
    assert.deepEqual(result.at, [f.instance.writer.stream.cursor().pos])
    const expect = read.expect()
    assert.equal(expect.nodes?.length, 1)
    assert.ok(expect.absent?.includes('/missing'))
    assert.equal(expect.selectors?.length, 1)
    for (const kind of ['actor', 'target', 'rights', 'type', 'epoch']) assert.ok(expect.dependencies?.some(dep => dep.kind === kind))
    const actor = expect.dependencies?.find(dep => dep.kind === 'actor')
    assert.deepEqual(actor?.value, f.anonymous.dependency())
    assert.ok(expect.dependencies?.some(dep => dep.kind === 'rights' && dep.key === '/list'))
    assert.ok(expect.dependencies?.some(dep => dep.kind === 'type' && dep.key === 'test.item'))
    assert.ok(expect.dependencies?.filter(dep => dep.kind === 'target').every(dep => isChildPath('/', dep.key, false) || dep.key === '/'))
  })

  it('delivers explicit includes for an empty list and bounds chains before loading nodes', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/public', { $acl: [{ subject: { group: 'public' }, grant: R }] }), put('/public/info', { link: '/public/info' })])
    const result = await f.reader().read({ children: '/empty', include: [{ path: '/public/info' }] })
    assert.deepEqual(result.list, [])
    assert.equal(result.copies.length, 1)
    assert.ok('node' in result.copies[0]); assert.equal(result.copies[0].node.$path, '/public/info')
    await assert.rejects(f.reader(f.anonymous, scanBudget(), { includeDepth: 1 }).read({ node: '/public/info',
      include: [{ ref: 'link', then: [{ ref: 'link' }] }] }), code('BUDGET'))
    assert.equal((await f.reader(f.anonymous, scanBudget(), { includeDepth: 1 }).read({ node: '/public/info', include: [{ ref: 'link' }] })).copies.length, 1)
  })

  it('owns the selector before waiting for an accepted write', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/public', { $acl: [{ subject: { group: 'public' }, grant: R }] }), put('/public/a', { score: 1 }), put('/secret', { score: 99 })])
    let release: () => void = () => {}, entered: () => void = () => {}
    const hold = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const writing = f.instance.writer.commit(f.store, [], async pos => {
      entered(); await hold
      return { writes: [], transitions: [], record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } }
    })
    await started
    const selector = { node: '/public/a' }
    const reading = f.reader().read(selector)
    selector.node = '/secret'
    release(); await writing
    const result = await reading
    assert.ok('node' in result.copies[0]); assert.equal(result.copies[0].node.score, 1)
    assert.deepEqual(result.at, [f.instance.writer.stream.cursor().pos])
  })

  it('registers the domain before loading and reports published rather than reserved positions', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/public', { $acl: [{ subject: { group: 'public' }, grant: R }] }), put('/public/a', { score: 1 })])
    const before = f.instance.writer.stream.cursor().pos
    let release: () => void = () => {}, entered: () => void = () => {}
    const hold = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const fill = f.instance.writer.cache.fill
    t.mock.method(f.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      if ('node' in args[1] && args[1].node === '/public/a') { entered(); await hold }
      return fill(...args)
    })
    const reading = f.reader().read({ node: '/public/a' })
    await started
    let committed = false
    const writing = f.commit([{ op: 'patch', path: '/public/a', ops: { $set: { score: 2 } } }]).then(() => { committed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(committed, false)
    assert.notDeepEqual(f.instance.writer.position, before)
    release()
    const result = await reading
    assert.deepEqual(result.at, [before])
    assert.ok('node' in result.copies[0]); assert.equal(result.copies[0].node.score, 1)
    await writing
    const latest = await f.reader().read({ node: '/public/a' })
    assert.ok('node' in latest.copies[0]); assert.equal(latest.copies[0].node.score, 2)
  })

  it('checks cancellation before releasing data and revalidates changed actor sources', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/public', { $acl: [{ subject: { group: 'public' }, grant: R }] })])
    const fill = f.instance.writer.cache.fill
    const original = t.mock.method(f.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      const lease = await fill(...args)
      if ('node' in args[1] && args[1].node === '/public') f.anonymous.close()
      return lease
    })
    await assert.rejects(f.reader().read({ node: '/public' }), code('CANCELLED'))
    original.mock.restore()
    await f.commit([{ op: 'patch', path: f.instance.bootstrap.adminPath, ops: { $set: { status: 'blocked' } } }])
    await assert.rejects(f.reader(f.admin).read({ node: '/public' }), code('UNAUTHENTICATED'))
  })

  it('keeps ordinary ancestor and account edits out of semantic rights dependencies', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/parent', { title: 'first' }), put('/parent/a', { score: 1 })])
    const read = f.reader(f.admin)
    await read.read({ node: '/parent/a' })
    const expect = read.expect()
    await f.commit([{ op: 'patch', path: '/parent', ops: { $set: { title: 'second' } } },
      { op: 'patch', path: f.instance.bootstrap.adminPath, ops: { $set: { name: 'renamed' } } },
      { op: 'move', from: f.instance.bootstrap.adminPath, to: '/auth/users/renamed' }])
    await f.instance.writer.read(f.source.domains, async () => {
      await f.admin.validate(f.source.auth)
      for (const dep of expect.dependencies ?? []) assert.deepEqual(read.dependency(dep), dep.value)
    })
    await f.commit([{ op: 'patch', path: '/parent', ops: { $set: { $owner: f.admin.actor.principal } } }])
    const dep = expect.dependencies?.find(input => input.kind === 'rights' && input.key === '/parent')
    assert.ok(dep); assert.notDeepEqual(read.dependency(dep), dep.value)
  })

  it('supplies real OCC inputs that refuse changes to a read node and a visible absence', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/public', { $acl: [{ subject: { group: 'public' }, grant: R }] }), put('/public/a', { score: 1 })])
    const read = f.reader()
    await read.read({ node: '/public/a', include: [{ path: '/public/missing' }] })
    async function check() {
      return f.instance.writer.commit(f.store, f.source.domains, async position => {
        await checkPreconditions(read.expect(), { index: f.instance.writer.influence, position, project: read.project, work: read.work,
          domains: read.domains, dependency: read.dependency,
          read: read.projectedNode })
        return { writes: [], transitions: [], record: { pos: position, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } }
      })
    }
    assert.ok(await check())
    await f.commit([put('/public/missing', { score: 3 })])
    await assert.rejects(check(), code('CONFLICT'))
    const changed = f.reader(); await changed.read({ node: '/public/a' })
    await f.commit([{ op: 'patch', path: '/public/a', ops: { $set: { score: 2 } } }])
    await assert.rejects(f.instance.writer.commit(f.store, f.source.domains, async position => {
      await checkPreconditions(changed.expect(), { index: f.instance.writer.influence, position, project: changed.project, work: changed.work,
        domains: changed.domains, dependency: changed.dependency,
        read: changed.projectedNode })
      return { writes: [], transitions: [], record: { pos: position, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } }
    }), code('CONFLICT'))
  })

  it('prunes projected absences before cache IO during commit preconditions', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/secret', { payload: 'x'.repeat(1000) })])
    const read = f.reader(f.anonymous, { ...scanBudget(), nodes: 0, bytes: 0 })
    const fill = t.mock.method(f.instance.writer.cache, 'fill')
    await f.instance.writer.read(f.source.domains, async () => {
      assert.equal(await read.projectedNode('/secret'), null)
      assert.equal(await read.projectedNode('/missing'), null)
    })
    assert.equal(fill.mock.callCount(), 0)
  })

  it('keeps visible malformed nodes as error copies with stored filter and sort values', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    t.mock.method(console, 'error', () => {})
    await f.commit([put('/public', { $acl: [{ subject: { group: 'public' }, grant: R }] }),
      { op: 'put', node: { $path: '/public/invalid', $type: 'test.typed', score: 1 } },
      { op: 'put', node: { $path: '/public/hidden', $type: 'test.typed', score: 2,
        $acl: [{ subject: { group: 'public' }, deny: R }] } }])
    for (const path of ['/public/invalid', '/public/hidden']) {
      const before = await f.instance.source.node(path)
      assert.ok(before)
      await f.instance.writer.commit(f.store, [], pos => {
        const node = { ...before, score: 'invalid', $pos: pos }
        return { writes: [{ path, node }], transitions: [], record: { pos, kind: 'reconcile', executor: 'external:test', caller: 'external:test',
          entries: [{ id: node.$id, path, change: { t: 'reconcile', after: node } }] } }
      })
    }
    const alerts: unknown[] = []
    const read = createReader({ registry: f.instance.registry, writer: f.instance.writer, admission: f.anonymous,
      source: f.source, budget: scanBudget(), alert: (_path, error) => { alerts.push(error) } })
    const result = await read.read({ children: '/public', where: { score: 'invalid' }, sort: [['score', 1]] })
    assert.equal(result.list.length, 1); assert.equal(result.copies.length, 1)
    assert.ok('error' in result.copies[0]); assert.equal(result.copies[0].path, '/public/invalid')
    assert.equal(result.copies[0].error.code, 'INVALID'); assert.equal(result.copies[0].sort?.score, 'invalid')
    assert.equal(alerts.length, 1)
    await f.instance.writer.read(f.source.domains, async () => {
      const projected = await read.projectedNode('/public/invalid')
      assert.equal(projected?.score, 'invalid')
      assert.equal(projected?.$acl, undefined)
    })
  })

  it('refuses data when a type rule tightens while its cache fill is awaiting IO', async t => {
    const f = await setup(); t.after(() => f.auth.close())
    await f.commit([put('/public', { $acl: [{ subject: { group: 'public' }, grant: R }] }), put('/public/secret', { value: 'classified' })])
    let release: () => void = () => {}, entered: () => void = () => {}
    const hold = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const fill = f.instance.writer.cache.fill
    t.mock.method(f.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      if ('node' in args[1] && args[1].node === '/public/secret') { entered(); await hold }
      return fill(...args)
    })
    const reading = f.reader().read({ node: '/public/secret' })
    await started
    f.instance.registry.publish({ ...f.module, security: [{ type: 'test.item', context: 'acl', handler: () => 0 }] })
    release()
    await assert.rejects(reading, code('CONFLICT'))
    await assert.rejects(f.reader().read({ node: '/public/secret' }), code('NOT_FOUND'))
  })

})
