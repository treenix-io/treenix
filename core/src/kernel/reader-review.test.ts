import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import type { AuthReadSource } from '#kernel/session'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import { R, W, type Budget, type ModuleManifest, type OpId, type Position } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
async function setup() {
  const root = createMemoryStore({ domain: 'reader-review' })
  let saved: Position | undefined, next = 0, allowance: (() => Budget) | undefined
  const instance = await createInstanceFoundation({ id: 'reader-review', root, writerEpoch: 1,
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    domains: [{ store: root, epoch: 'reader-review1', persistent: true }], budget: () => allowance === undefined ? scanBudget() : allowance(),
    firstAdmin: { path: '/admin', name: 'admin', password: 'reader-review-password' }, initialCredential: { ttlMs: 60_000 } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  const anonymous = instance.commands(await instance.auth.openCredential())
  const key = (): OpId => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++next) })
  return { instance, root, admin, anonymous, key, budget(value: () => Budget) { allowance = value } }
}

describe('independent native Reader composition', { timeout: 10_000 }, () => {
  it('expires a hidden-only child scan without reading any hidden payload', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
    const f = await setup(); t.after(() => f.instance.auth.close())
    const module: ModuleManifest = { id: 'reader-review', types: [{ name: 'review.hidden', module: 'reader-review',
      security: 'ordinary', version: 0, schema: {}, actions: {} }], security: [], open: [] }
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/sys/types/review.hidden', $type: 't.type', name: 'review.hidden', module: module.id, security: 'ordinary' } },
    ] })
    f.instance.registry.publish(module)
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/hidden', $type: 't.dir' } },
      { op: 'put', node: { $path: '/hidden/child', $type: 'review.hidden', payload: 'x'.repeat(100_000) } },
    ] })
    let expired = false
    f.instance.registry.publish({ ...module, security: [{ type: 'review.hidden', context: 'acl', handler: () => {
      if (!expired) { expired = true; t.mock.timers.tick(101) }
      return 0
    } }] })
    const loaded: string[] = [], fill = f.instance.writer.cache.fill
    t.mock.method(f.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      if ('node' in args[1]) loaded.push(args[1].node)
      return fill(...args)
    })
    f.budget(() => ({ ...scanBudget(), deadline: Date.now() + 100 }))
    await assert.rejects(f.anonymous.read({ children: '/hidden' }), code('BUDGET'))
    assert.equal(expired, true)
    assert.equal(loaded.includes('/hidden/child'), false)
  })

  it('reads projected public fields with bounded payload IO through the authenticated commands', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/list', $type: 't.dir' } },
      { op: 'put', node: { $path: '/list/public', $type: 't.dir', score: 7, $owner: f.admin.actor.principal,
        $acl: [{ subject: { group: 'public' }, grant: R }] } },
      ...Array.from({ length: 15 }, (_, index) => ({ op: 'put' as const, node: { $path: `/list/private${index}`, $type: 't.dir', score: 99, payload: 'x'.repeat(30_000) } })),
    ] })
    const loaded: string[] = [], fill = f.instance.writer.cache.fill
    t.mock.method(f.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      if ('node' in args[1]) loaded.push(args[1].node)
      return fill(...args)
    })
    f.budget(() => ({ ...scanBudget(), nodes: 1, bytes: 1024 }))
    const result = await f.anonymous.read({ children: '/list', where: { score: 7 }, sort: [['score', -1]], window: { limit: 1 } })
    assert.equal(result.list.length, 1)
    assert.ok('node' in result.copies[0])
    assert.equal(result.copies[0].node.$path, '/list/public')
    assert.equal(result.copies[0].node.$owner, undefined)
    assert.equal(result.copies[0].node.$acl, undefined)
    assert.equal(loaded.some(path => path.startsWith('/list/private')), false)
    assert.deepEqual(result.at, [f.instance.writer.stream.cursor().pos])
  })

  it('rejects escaped accepted read sources after either completion or callback failure', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    const account = await f.instance.source.node('/admin'); assert.ok(account)
    let escaped: AuthReadSource | undefined
    await f.instance.source.read(async source => { escaped = source; assert.equal((await source.nodeById(account.$id))?.$path, '/admin') })
    assert.ok(escaped)
    await assert.rejects(escaped.node('/admin'), code('INVALID'))
    await assert.rejects(escaped.nodeById(account.$id), code('INVALID'))
    assert.throws(() => escaped?.shard('/admin'), code('INVALID'))
    await assert.rejects(f.instance.source.read(async source => { escaped = source; throw new KernelError('REFUSED', 'Rejected callback') }), code('REFUSED'))
    await assert.rejects(escaped.node('/admin'), code('INVALID'))
    const outcome = await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/after', $type: 't.dir' } }] })
    assert.deepEqual((await f.admin.read({ node: '/after' })).at, [outcome.pos])
    const before = f.instance.writer.stream.cursor().pos
    let abortedAt: Position | undefined
    f.admin.signal.addEventListener('abort', () => { abortedAt = f.instance.writer.stream.cursor().pos }, { once: true })
    const blocked = await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/admin', ops: { $set: { status: 'blocked' } } }] })
    assert.equal(f.admin.signal.aborted, true)
    assert.deepEqual(abortedAt, before)
    assert.deepEqual(f.instance.writer.stream.cursor().pos, blocked.pos)
    assert.equal((await f.instance.source.nodeById(account.$id))?.status, 'blocked')
    await assert.rejects(f.admin.read({ node: '/after' }), code('UNAUTHENTICATED'))
  })

  it('checks projected absence atomically and rejects a hidden node that became visible', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/shared', $type: 't.dir', $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
      { op: 'put', node: { $path: '/shared/private', $type: 't.dir', score: 1, $acl: [{ subject: { group: 'public' }, deny: R }] } },
    ] })
    await assert.rejects(f.anonymous.read({ node: '/shared/private' }), code('NOT_FOUND'))
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/shared/private', ops: { $set: { score: 2 } } }] })
    const accepted = await f.anonymous.commit({ opId: f.key(), expect: { absent: ['/shared/private'] },
      changes: [{ op: 'put', node: { $path: '/shared/accepted', $type: 't.dir' } }] })
    assert.deepEqual((await f.anonymous.read({ node: '/shared/accepted' })).at, [accepted.pos])
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/shared/private', ops: { $unset: { $acl: true } } }] })
    await assert.rejects(f.anonymous.commit({ opId: f.key(), expect: { absent: ['/shared/private'] },
      changes: [{ op: 'put', node: { $path: '/shared/rejected', $type: 't.dir' } }] }), code('CONFLICT'))
    assert.equal(await f.instance.source.node('/shared/rejected'), null)
    const result = await f.anonymous.read({ node: '/shared/private' })
    assert.ok('node' in result.copies[0]); assert.equal(result.copies[0].node.score, 2)
  })
})
