import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { register, unregister } from '#core/registry'
import { KernelError } from '#errors'
import { createTestInstance } from '#kernel/testing'
import { R, W, type ModuleManifest, type TestInstanceConfig } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const module: ModuleManifest = { id: 'test-factory', types: [
  { name: 'factory.item', module: 'test-factory', security: 'ordinary', version: 0,
    schema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
    actions: { increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } } } },
  { name: 'factory.worker', module: 'test-factory', security: 'user-capability', version: 0, schema: {},
    actions: { run: { kind: 'setuid', args: {}, handler: async () => undefined } } },
], security: [], open: [] }

function config(count: number): TestInstanceConfig<'reader' | 'worker'> {
  return { modules: [module], seed: [
    { $path: '/work', $type: 't.dir', $acl: [{ subject: { group: 'public' }, grant: R | W }] },
    { $path: '/work/item', $type: 'factory.item', count },
    { $path: '/worker', $type: 'factory.worker' },
  ], actors: { reader: { kind: 'credential' }, worker: { kind: 'node', node: '/worker' } } }
}

describe('real native test instance', { timeout: 10_000 }, () => {
  it('uses independent Registry/seed state and genuine actor sessions with drained Pending delivery', async t => {
    const first = await createTestInstance(config(1)); t.after(() => first.close())
    const second = await createTestInstance(config(10)); t.after(() => second.close())
    assert.notEqual(first.instance.registry, second.instance.registry)
    const before = (await first.actors.reader.read({ node: '/work/item' })).copies[0]
    const other = (await second.actors.reader.read({ node: '/work/item' })).copies[0]
    assert.ok('node' in before && 'node' in other)
    assert.notEqual(before.node.$id, other.node.$id)
    assert.equal(before.node.count, 1)
    assert.equal(other.node.count, 10)
    const session = await first.instance.openSession()
    const welcome = await session.lane[Symbol.asyncIterator]().next()
    assert.ok(!welcome.done && welcome.value.t === 'welcome')
    const intake = welcome.value.intake
    const key = (nonce: string) => ({ epoch: intake, time: Date.now(), nonce })
    const pending = first.actors.reader.act({ path: '/work/item', action: 'increment', args: {}, opId: key('increment') })
    assert.ok((await pending.outcome).pos)
    assert.deepEqual(await collect(pending.chunks), [])
    const commit = first.actors.reader.commit({ changes: [{ op: 'patch', path: '/work/item', ops: { $set: { count: 5 } } }], opId: key('edit') })
    assert.ok((await commit.outcome).pos)
    const changed = (await first.actors.reader.read({ node: '/work/item' })).copies[0]
    const unchanged = (await second.actors.reader.read({ node: '/work/item' })).copies[0]
    assert.ok('node' in changed && 'node' in unchanged)
    assert.equal(changed.node.count, 5)
    assert.equal(unchanged.node.count, 10)
    assert.ok(first.actors.worker.actor.principal.startsWith('n:'))
    await assert.rejects(first.actors.worker.read({ node: '/work/item' }), code('NOT_FOUND'))
    const iterator = session.lane[Symbol.asyncIterator](); await iterator.return?.()
    await first.close()
    await assert.rejects(async () => first.actors.reader.read({ node: '/work/item' }), code('CANCELLED'))
    assert.ok('node' in (await second.actors.reader.read({ node: '/work/item' })).copies[0])
  })

  it('installs ambient native types into each own Registry through an admin journaled commit', async t => {
    register('factory.ambient', 'schema', () => ({ $id: 'factory.ambient', type: 'object', properties: {} }))
    t.after(() => unregister('factory.ambient', 'schema'))
    const test = await createTestInstance({ modules: [], seed: [{ $path: '/ambient', $type: 'factory.ambient',
      $acl: [{ subject: { group: 'public' }, grant: R }] }], actors: { visitor: { kind: 'credential' } } })
    t.after(() => test.close())
    assert.equal(test.instance.registry.type('factory.ambient').module, 'ambient')
    assert.ok('node' in (await test.actors.visitor.read({ node: '/ambient' })).copies[0])
    const journal = test.instance.stream.follow(test.initialCursor)
    const records = journal[Symbol.asyncIterator]()
    const ownership = await records.next()
    assert.ok(!ownership.done && ownership.value.t === 'commit')
    assert.ok(ownership.value.record.caller.startsWith('u:'))
    assert.ok(ownership.value.record.entries.some(entry => entry.path === '/sys/types/factory.ambient'))
    await records.return?.()
  })

  it('propagates malformed seeds, forged credentials and missing capability declarations loudly', async () => {
    await assert.rejects(createTestInstance({ modules: [module], seed: [{ $path: '/bad', $type: 'factory.item', count: 'bad' }], actors: {} }), code('INVALID'))
    await assert.rejects(createTestInstance({ modules: [], seed: [], actors: { forged: { kind: 'credential', credential: { token: 'forged' } } } }), code('UNAUTHENTICATED'))
    await assert.rejects(createTestInstance({ modules: [], seed: [{ $path: '/ordinary', $type: 't.dir' }], actors: { ordinary: { kind: 'node', node: '/ordinary' } } }), code('INVALID'))
  })
})

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []
  for await (const value of source) result.push(value)
  return result
}
