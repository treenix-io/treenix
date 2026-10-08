import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { createRegistry } from './registry'
import type { ActionDef, Migration, ModuleManifest, SecurityClass, SecurityRegistration, TypeDef } from './types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const type = (name = 'test.item', module = 'owner', security: SecurityClass = 'ordinary'): TypeDef => ({
  name, module, security, schema: { type: 'object' }, version: 0, actions: {},
})
const manifest = (id = 'owner', types: readonly TypeDef[] = [type()], security: readonly SecurityRegistration[] = []): ModuleManifest => ({
  id, types, security, open: [],
})

describe('kernel registry', () => {
  it('keeps kernel instances independent', () => {
    const first = createRegistry()
    const second = createRegistry()
    const empty = second.digest
    first.publish(manifest())
    assert.equal(first.type('test.item').module, 'owner')
    assert.throws(() => second.type('test.item'), code('UNKNOWN_TYPE'))
    assert.equal(second.digest, empty)
  })

  it('resolves aliases to the same type and rejects unknown names', () => {
    const registry = createRegistry()
    registry.publish(manifest('owner', [{ ...type(), aliases: ['test.old'] }]))
    assert.equal(registry.type('test.old'), registry.type('test.item'))
    assert.throws(() => registry.type('test.unknown'), code('UNKNOWN_TYPE'))
  })

  it('rejects every security context in open registrations atomically', () => {
    const registry = createRegistry()
    const before = registry.digest
    for (const context of ['acl', 'migrate', 'mount', 'service', 'derive']) {
      assert.throws(() => registry.publish({ ...manifest(), open: [{ type: 'test.item', context, handler: () => 7 }] }), code('FORBIDDEN'))
      assert.equal(registry.digest, before)
      assert.throws(() => registry.type('test.item'), code('UNKNOWN_TYPE'))
    }
  })

  it('rejects foreign security registrations for all five contexts', () => {
    const registry = createRegistry()
    registry.publish(manifest('owner', [type('test.item', 'owner', 'user-capability')]))
    const registrations: SecurityRegistration[] = [
      { type: 'test.item', context: 'acl', handler: () => 7 },
      { type: 'test.item', context: 'migrate', handler: [] },
      { type: 'test.item', context: 'mount', handler: async () => { throw new Error('unused') } },
      { type: 'test.item', context: 'service', handler: async () => ({ stop: async () => {} }) },
      { type: 'test.item', context: 'derive', handler: async () => ({ members: [] }) },
    ]
    const before = registry.digest
    for (const registration of registrations) {
      assert.throws(() => registry.publish(manifest('foreign', [], [registration])), code('FORBIDDEN'))
      assert.equal(registry.digest, before)
      assert.equal(registry.security('test.item', registration.context), undefined)
    }
  })

  it('rejects another type owner and preserves the first security class', () => {
    const registry = createRegistry()
    registry.publish(manifest())
    assert.throws(() => registry.publish(manifest('foreign', [type('test.item', 'foreign')])), code('FORBIDDEN'))
    assert.throws(() => registry.publish(manifest('owner', [type('test.item', 'owner', 'privileged-capability')])), code('FORBIDDEN'))
    assert.equal(registry.type('test.item').security, 'ordinary')
  })

  it('keeps ownership and security class after an owner removes a type', () => {
    const registry = createRegistry()
    registry.publish(manifest())
    registry.publish(manifest('owner', []))
    assert.throws(() => registry.type('test.item'), code('UNKNOWN_TYPE'))
    assert.throws(() => registry.publish(manifest('foreign', [type('test.item', 'foreign')])), code('FORBIDDEN'))
    assert.throws(() => registry.publish(manifest('owner', [type('test.item', 'owner', 'user-capability')])), code('FORBIDDEN'))
  })

  it('rejects alias collisions and a false owner declaration', () => {
    const registry = createRegistry()
    registry.publish(manifest('owner', [{ ...type(), aliases: ['test.old'] }]))
    assert.throws(() => registry.publish(manifest('foreign', [type('test.old', 'foreign')])), code('FORBIDDEN'))
    assert.throws(() => registry.publish(manifest('foreign', [type('test.other', 'owner')])), code('FORBIDDEN'))
    assert.throws(() => registry.publish(manifest('owner', [type(), { ...type('test.other'), aliases: ['test.item'] }])), code('INVALID'))
  })

  it('requires a capability class for mount, service and derive', () => {
    const registry = createRegistry()
    assert.throws(() => registry.publish(manifest('owner', [type()], [
      { type: 'test.item', context: 'derive', handler: async () => ({ members: [] }) },
    ])), code('FORBIDDEN'))
    registry.publish(manifest('owner', [type('test.item', 'owner', 'user-capability')], [
      { type: 'test.item', context: 'derive', handler: async () => ({ members: [] }) },
    ]))
    assert.equal(typeof registry.security('test.item', 'derive'), 'function')
  })

  it('allows foreign open contexts while rejecting a second publisher of the same entry', () => {
    const registry = createRegistry()
    registry.publish(manifest())
    const view = () => 'view'
    registry.publish({ ...manifest('views', []), open: [{ type: 'test.item', context: 'react', handler: view }] })
    const before = registry.digest
    assert.throws(() => registry.publish({ ...manifest('other', []), open: [{ type: 'test.item', context: 'react', handler: () => 'other' }] }), code('CONFLICT'))
    assert.equal(registry.handler('test.item', 'react'), view)
    assert.equal(registry.digest, before)
  })

  it('replaces all entries of an owner generation together', () => {
    const registry = createRegistry()
    const oldRule = () => 1
    const oldDigest = registry.publish({ ...manifest('owner', [type()], [{ type: 'test.item', context: 'acl', handler: oldRule }]),
      open: [{ type: 'test.item', context: 'react', handler: () => 'old' }],
    })
    const rule = () => 3
    const digest = registry.publish(manifest('owner', [{ ...type(), version: 1 }], [{ type: 'test.item', context: 'acl', handler: rule }]))
    assert.notEqual(digest, oldDigest)
    assert.equal(digest, registry.digest)
    assert.equal(registry.type('test.item').version, 1)
    assert.equal(registry.security('test.item', 'acl'), rule)
    assert.equal(registry.handler('test.item', 'react'), undefined)
  })

  it('failed republishing leaves both handlers and definitions intact', () => {
    const registry = createRegistry()
    const rule = () => 1
    const before = registry.publish(manifest('owner', [type()], [{ type: 'test.item', context: 'acl', handler: rule }]))
    assert.throws(() => registry.publish({ ...manifest('owner', [{ ...type(), version: 2 }]),
      open: [{ type: 'test.item', context: 'acl', handler: () => 7 }],
    }), code('FORBIDDEN'))
    assert.equal(registry.type('test.item').version, 0)
    assert.equal(registry.security('test.item', 'acl'), rule)
    assert.equal(registry.digest, before)
  })

  it('never falls back by type or context suffix', () => {
    const registry = createRegistry()
    const rule = () => 1
    registry.publish({ ...manifest('owner', [{ ...type(), aliases: ['test.old'] }, type('default')], [
      { type: 'default', context: 'acl', handler: rule }, { type: 'test.item', context: 'acl', handler: rule },
    ]),
      open: [{ type: 'default', context: 'react', handler: () => 'default' }, { type: 'test.item', context: 'react', handler: () => 'exact' }],
    })
    assert.equal(registry.security('test.unknown', 'acl'), undefined)
    assert.equal(registry.security('test.old', 'acl'), rule)
    assert.equal(registry.handler('test.old', 'react'), registry.handler('test.item', 'react'))
    assert.equal(registry.handler('test.item', 'react:compact'), undefined)
    assert.equal(registry.handler('test.unknown', 'react'), undefined)
    assert.equal(typeof registry.handler('test.item', 'react'), 'function')
  })

  it('an owner can register through an alias without creating a second type', () => {
    const registry = createRegistry()
    const rule = () => 1
    const view = () => 'view'
    registry.publish({ ...manifest('owner', [{ ...type(), aliases: ['test.old'] }], [{ type: 'test.old', context: 'acl', handler: rule }]),
      open: [{ type: 'test.old', context: 'react', handler: view }],
    })
    assert.equal(registry.security('test.item', 'acl'), rule)
    assert.equal(registry.security('test.old', 'acl'), rule)
    assert.equal(registry.handler('test.item', 'react'), view)
    assert.equal(registry.handler('test.old', 'react'), view)
    assert.throws(() => registry.publish({ ...manifest('foreign', []), open: [{ type: 'test.item', context: 'react', handler: () => 'foreign' }] }), code('CONFLICT'))
  })

  it('preserves open entry metadata as part of the opaque binding value', () => {
    const registry = createRegistry()
    const entry = { handler: () => 'view', meta: { props: { compact: true } } }
    registry.publish({ ...manifest(), open: [{ type: 'test.item', context: 'react', handler: entry }] })
    assert.equal(registry.handler('test.item', 'react'), entry)
    assert.equal(registry.handler('test.item', 'react:compact'), undefined)
  })

  it('security lookups ignore inherited object properties', () => {
    const registry = createRegistry()
    registry.publish(manifest('owner', [type()], [{ type: 'test.item', context: 'migrate', handler: [] }]))
    for (const context of ['toString', 'constructor', '__proto__']) {
      assert.equal(Reflect.apply(registry.security, registry, ['test.item', context]), undefined)
    }
  })

  it('hashes content independently of publication, registration and object key order', () => {
    const first = createRegistry()
    const second = createRegistry()
    const view = () => 'view'
    const a: ModuleManifest = { ...manifest(), types: [{ ...type(), schema: { type: 'object', properties: { x: { type: 'string' } } } }],
      open: [{ type: 'test.item', context: 'react', handler: view }, { type: 'test.item', context: 'text', handler: view }],
    }
    const b = manifest('other', [type('test.other', 'other')])
    first.publish(a)
    first.publish(b)
    second.publish(b)
    second.publish({ ...a, types: [{ ...type(), schema: { properties: { x: { type: 'string' } }, type: 'object' } }], open: [...a.open].reverse() })
    assert.equal(first.digest, second.digest)
    assert.equal(first.publish(a), first.digest)
  })

  it('includes schemas and real handler source text in the digest', () => {
    const registry = createRegistry()
    const first = registry.publish(manifest('owner', [type()], [{ type: 'test.item', context: 'acl', handler: () => 1 }]))
    const second = registry.publish(manifest('owner', [type()], [{ type: 'test.item', context: 'acl', handler: () => 3 }]))
    const third = registry.publish(manifest('owner', [{ ...type(), schema: { type: 'object', required: ['x'] } }], [{ type: 'test.item', context: 'acl', handler: () => 3 }]))
    assert.notEqual(first, second)
    assert.notEqual(second, third)
  })

  it('a digest failure commits neither a generation nor ownership reservations', () => {
    const registry = createRegistry()
    const before = registry.publish(manifest())
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    assert.throws(() => registry.publish({ ...manifest('owner', [type(), type('test.new')]),
      open: [{ type: 'test.item', context: 'react', handler: cycle }],
    }), code('INVALID'))
    assert.equal(registry.digest, before)
    assert.throws(() => registry.type('test.new'), code('UNKNOWN_TYPE'))
    registry.publish(manifest('foreign', [type('test.new', 'foreign')]))
    assert.equal(registry.type('test.new').module, 'foreign')
  })

  it('owns a published generation when the publisher edits its next manifest', () => {
    const registry = createRegistry()
    const properties = { value: { type: 'number' } }
    const aliases = ['test.old']
    const types: TypeDef[] = [{ ...type(), schema: { type: 'object', properties }, aliases }]
    const view = () => 'view'
    const open = [{ type: 'test.item', context: 'react', handler: view }]
    const content = { ...manifest(), types, open }
    const before = registry.publish(content)
    properties.value.type = 'string'
    aliases.push('test.other')
    types.push({ ...type('test.new'), schema: { type: 'object', properties: {} }, aliases: [] })
    open[0].context = 'text'

    assert.equal(registry.digest, before)
    assert.deepEqual(registry.type('test.item').schema, { type: 'object', properties: { value: { type: 'number' } } })
    assert.throws(() => registry.type('test.new'), code('UNKNOWN_TYPE'))
    assert.throws(() => registry.type('test.other'), code('UNKNOWN_TYPE'))
    assert.equal(registry.handler('test.item', 'react'), view)
    assert.equal(registry.handler('test.item', 'text'), undefined)
    assert.notEqual(registry.publish(content), before)
    assert.equal(registry.type('test.other'), registry.type('test.item'))
  })

  it('snapshots action declarations and migration steps while retaining callable handlers', () => {
    const registry = createRegistry()
    const args = { type: 'string' }
    const pre = { 'node.status': 'new' }
    const needs = { account: { node: '/account' } }
    const ops = { $set: { status: 'paid' } }
    const handler = async () => true
    const action: ActionDef = { kind: 'write', args, pre, needs, post: { '': ops }, handler }
    const steps: Migration[] = [{ from: 0, to: 1, up: component => component }]
    registry.publish(manifest('owner', [{ ...type(), actions: { pay: action } }], [{ type: 'test.item', context: 'migrate', handler: steps }]))
    args.type = 'number'
    pre['node.status'] = 'changed'
    needs.account.node = '/changed'
    ops.$set.status = 'changed'
    steps.push({ from: 1, to: 2, up: component => component })

    const published = registry.type('test.item').actions.pay
    assert.deepEqual(published.args, { type: 'string' })
    assert.deepEqual(published.pre, { 'node.status': 'new' })
    assert.deepEqual(published.needs, { account: { node: '/account' } })
    assert.ok(published.kind !== 'read')
    assert.deepEqual(published.post, { '': { $set: { status: 'paid' } } })
    assert.equal(published.handler, handler)
    assert.equal(registry.security('test.item', 'migrate')?.length, 1)
    assert.equal(Reflect.set(published.args, 'type', 'mutated'), false)
  })

  it('digests deeply nested arrays without repeatedly walking their contents', { timeout: 1000 }, () => {
    const registry = createRegistry()
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 64; depth++) nested = [nested]
    const content = { ...manifest(), open: [{ type: 'test.item', context: 'data', handler: nested }] }
    const before = registry.publish(content)
    assert.equal(registry.publish(content), before)
  })
})
