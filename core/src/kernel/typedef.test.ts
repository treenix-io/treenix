import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getRegistryVersion } from '#core/registry'
import { KernelError } from '#errors'
import type { TypeSchema } from '#schema/types'
import { createRegistry } from './registry'
import { buildTypeDef } from './typedef'
import { DEFAULT_LIMITS, type ReadActionContext, type WriteActionContext } from './types'

const invalid = (error: unknown) => error instanceof KernelError && error.code === 'INVALID'
const context: WriteActionContext = {
  node: { $path: '/counter', $id: 'counter', $type: 'test.counter', $rev: '0', value: 1 },
  needs: {},
  read: { read: async () => ({ list: [], copies: [], at: [] }) },
  caller: { principal: 'u:alice', claims: ['u:alice'] },
  executor: { principal: 'u:alice', claims: ['u:alice'] },
  change: {
    put: () => { throw new Error('unused') }, patch: () => { throw new Error('unused') },
    remove: () => { throw new Error('unused') }, move: () => { throw new Error('unused') }, restore: () => { throw new Error('unused') },
  },
}
const options = (schema: TypeSchema) => ({ name: 'test.counter', module: 'test', security: 'ordinary' as const, schema })

class Counter {
  value = 1
  read() { return this.value }
  increment(amount: number) { this.value += amount; return this.value }
  async *count() { yield this.value; return this.value + 1 }
  _internal() { throw new Error('private') }
}
const schema: TypeSchema = {
  type: 'object', properties: { value: { type: 'number' } }, required: ['value'],
  methods: {
    read: { kind: 'read', arguments: [] },
    increment: { arguments: [{ name: 'amount', type: 'number' }] },
    count: { kind: 'read', arguments: [] },
  },
}

describe('class type definitions', () => {
  it('uses generated field, argument and type metadata without publishing globally', () => {
    const before = getRegistryVersion()
    const generated: TypeSchema = { ...schema, version: 3, actionsOnly: true, aliases: ['test.old'] }
    const def = buildTypeDef(Counter, options(generated))
    assert.equal(def.name, 'test.counter')
    assert.equal(def.module, 'test')
    assert.equal(def.security, 'ordinary')
    assert.equal(def.version, 3)
    assert.equal(def.actionsOnly, true)
    assert.deepEqual(def.aliases, ['test.old'])
    assert.deepEqual(def.schema, { type: 'object', properties: schema.properties, required: ['value'] })
    assert.deepEqual(def.actions.increment.args, { type: 'number' })
    assert.deepEqual(def.actions.read.args, {})
    assert.equal(def.actions.increment.kind, 'write')
    assert.equal(def.actions.read.kind, 'read')
    assert.deepEqual(Object.keys(def.actions).sort(), ['count', 'increment', 'read'])
    assert.equal(getRegistryVersion(), before)
  })

  it('invokes a method with the supplied component receiver, including named components', async () => {
    const def = buildTypeDef(Counter, options(schema))
    const component = { $type: 'test.counter', value: 7 }
    const increment = def.actions.increment
    assert.ok(increment.kind !== 'read' && increment.handler)
    assert.equal(await increment.handler.call(component, context, 2), 9)
    const read = def.actions.read
    assert.equal(read.kind, 'read')
    assert.ok(read.handler)
    const readContext: ReadActionContext = context
    assert.equal(await read.handler.call(component, readContext, undefined), 9)
    assert.equal(context.node.value, 1)
  })

  it('preserves async generator chunks and the final result', async () => {
    const def = buildTypeDef(Counter, options(schema))
    const count = def.actions.count
    assert.equal(count.kind, 'read')
    assert.ok(count.kind === 'read')
    const stream = count.handler.call({ $type: 'test.counter', value: 4 }, context, undefined)
    assert.ok('next' in stream)
    assert.deepEqual(await stream.next(), { value: 4, done: false })
    assert.deepEqual(await stream.next(), { value: 5, done: true })
  })

  it('retains pre, post, setuid and I/O metadata', () => {
    class Payment { pay() { return 'paid' } }
    const pre = { 'node.status': 'new' }
    const post = { '': { $set: { status: 'paid' } } }
    const def = buildTypeDef(Payment, options({ type: 'object', properties: {}, methods: {
      pay: { arguments: [], kind: 'setuid', io: true, pre, post },
    } }))
    assert.equal(def.actions.pay.kind, 'setuid')
    assert.equal(def.actions.pay.io, true)
    assert.deepEqual(def.actions.pay.pre, pre)
    assert.deepEqual(def.actions.pay.post, post)
    assert.equal(typeof def.actions.pay.handler, 'function')
    assert.equal(def.version, 0)
  })

  it('compiles per-action and shared needs into relative selectors', () => {
    const def = buildTypeDef(Counter, { ...options(schema), needs: {
      '*': ['../config'], increment: ['./items/*', '@account'],
    } })
    assert.deepEqual(def.actions.read.needs, { config: { node: '../config' } })
    assert.deepEqual(def.actions.increment.needs, {
      items: { children: './items' }, account: { node: '.', include: [{ ref: 'account' }] },
    })
    assert.throws(() => buildTypeDef(Counter, { ...options(schema), needs: { increment: ['payment'] } }), invalid)
  })

  it('does not execute getters while discovering public methods', () => {
    class WithGetter {
      get computed() { throw new Error('getter must run only on an instance') }
      run() { return 1 }
    }
    const def = buildTypeDef(WithGetter, options({ type: 'object', properties: {}, methods: { run: { arguments: [] } } }))
    assert.deepEqual(Object.keys(def.actions), ['run'])
  })

  it('rejects a missing public method schema or a stale public schema entry', () => {
    assert.throws(() => buildTypeDef(Counter, options({ type: 'object', properties: {} })), invalid)
    assert.throws(() => buildTypeDef(Counter, options({ ...schema, methods: { ...schema.methods, gone: { arguments: [] } } })), invalid)
  })

  it('rejects more than one data argument', () => {
    class Pair { run() {} }
    assert.throws(() => buildTypeDef(Pair, options({ type: 'object', properties: {}, methods: {
      run: { arguments: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }] },
    } })), invalid)
  })

  it('rejects external effects and post on read actions', () => {
    class Read { run() {} }
    for (const method of [
      { arguments: [], kind: 'read' as const, io: true },
      { arguments: [], kind: 'read' as const, post: { '': { $inc: { count: 1 } } } },
    ]) assert.throws(() => buildTypeDef(Read, options({ type: 'object', properties: {}, methods: { run: method } })), invalid)
  })

  it('detects streaming from the actual method and refuses a streaming post', () => {
    class Stream { async *run() { yield 1 } }
    assert.throws(() => buildTypeDef(Stream, options({ type: 'object', properties: {}, methods: {
      run: { arguments: [], post: { '': { $inc: { count: 1 } } } },
    } })), invalid)
    class Plain { run() {} }
    assert.throws(() => buildTypeDef(Plain, options({ type: 'object', properties: {}, methods: {
      run: { arguments: [], streaming: true },
    } })), invalid)
  })

  it('validates pre and post with the shared expression and update contracts', () => {
    class Run { run() {} }
    const build = (method: NonNullable<TypeSchema['methods']>[string]) => buildTypeDef(Run, options({ type: 'object', properties: {}, methods: { run: method } }))
    assert.throws(() => build({ arguments: [], pre: { $regex: '.*' } }), invalid)
    assert.throws(() => build({ arguments: [], post: { '': { $set: { x: {}, 'x.y': 1 } } } }), invalid)
    assert.throws(() => buildTypeDef(Run, { ...options({ type: 'object', properties: {}, methods: {
      run: { arguments: [], pre: { value: 'long expression' } },
    } }), limits: { ...DEFAULT_LIMITS, exprBytes: 1 } }), (error: unknown) => error instanceof KernelError && error.code === 'BUDGET')
  })

  it('includes the class method implementation in the registry content digest', () => {
    class First { run() { return 1 } }
    class Second { run() { return 2 } }
    const generated: TypeSchema = { type: 'object', properties: {}, methods: { run: { arguments: [] } } }
    const registry = createRegistry()
    const publish = (def: ReturnType<typeof buildTypeDef>) => registry.publish({ id: 'test', types: [def], security: [], open: [] })
    const first = publish(buildTypeDef(First, options(generated)))
    assert.equal(publish(buildTypeDef(First, options(generated))), first)
    assert.notEqual(publish(buildTypeDef(Second, options(generated))), first)
  })
})
