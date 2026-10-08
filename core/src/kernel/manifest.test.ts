import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { registerActions, registerType } from '#comp'
import { getRegistryVersion, mapRegistry, register, registerLegacy, replaceHandler, resolveExact, resolveExactEntry, unregister } from '#core/registry'
import { kernelManifest } from '#kernel/builtins'
import { KernelError } from '#errors'
import type { TypeSchema } from '#schema/types'
import { ambientModule, assertModuleSchema, assertNoAmbientRegistrations, clearAmbientRegistrations, clearCollectedModules,
  collectModule, getCollectedModule, publishModules, registerKernel, registerKernelAction } from './manifest'
import { createRegistry } from './registry'
import type { ReadActionContext, WriteActionContext } from './types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const schema = (type: string, extra: Partial<TypeSchema> = {}): void => {
  register(type, 'schema', () => ({ $id: type, type: 'object', properties: {}, ...extra }))
}
const context: WriteActionContext = {
  node: { $path: '/item', $id: 'item', $type: 'manifest.item', $rev: '0', value: 1 },
  needs: { config: { list: [], copies: [], at: [] } },
  read: { read: async () => ({ list: [], copies: [], at: [] }) },
  caller: { principal: 'u:alice', claims: ['u:alice'] },
  executor: { principal: 'u:alice', claims: ['u:alice'] },
  act: async () => { throw new Error('unused') },
  change: {
    put: () => { throw new Error('unused') }, patch: () => { throw new Error('unused') },
    remove: () => { throw new Error('unused') }, move: () => { throw new Error('unused') }, restore: () => { throw new Error('unused') },
  },
}

function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => { throw new Error('gate is not ready') }
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

describe('module manifest collection', () => {
  let restore: () => void
  beforeEach(() => {
    const previous = mapRegistry((type, context) => ({ type, context, entry: resolveExactEntry(type, context)! }))
    clearAmbientRegistrations()
    clearCollectedModules()
    restore = () => {
      mapRegistry((type, context) => { unregister(type, context) })
      clearAmbientRegistrations()
      clearCollectedModules()
      for (const { type, context, entry } of previous) registerLegacy(type, context, entry.handler, entry.meta)
    }
  })
  afterEach(() => restore())

  it('collects class methods and separately declared actions with their own needs', async () => {
    class Item {
      value = 1
      read() { return this.value }
      _internal() { return this.value }
    }
    class Actions {
      value = 1
      increment(amount: number, needs: unknown) { this.value += amount; return { value: this.value, needs } }
      async *count() { yield this.value; return this.value + 1 }
    }
    const view = () => 'view'
    const manifest = await collectModule('items', () => {
      registerType('manifest.item', Item)
      registerActions('manifest.item', Actions, { needs: { increment: ['../config'] } })
      register('manifest.item', 'react', view, { props: { compact: true } })
      schema('manifest.item', { version: 2, methods: {
        read: { kind: 'read', arguments: [] },
        increment: { arguments: [{ name: 'amount', type: 'number' }] },
        count: { kind: 'read', arguments: [], streaming: true },
      } })
    })
    assert.equal(manifest.types.length, 1)
    assert.equal(manifest.types[0].module, 'items')
    assert.equal(manifest.types[0].version, 2)
    assert.deepEqual(Object.keys(manifest.types[0].actions).sort(), ['count', 'increment', 'read'])
    assert.deepEqual(manifest.legacyActions, [])
    const registry = createRegistry()
    publishModules(registry, [manifest])
    assert.deepEqual(registry.handler('manifest.item', 'react'), { handler: view, meta: { props: { compact: true } } })
    const increment = registry.type('manifest.item').actions.increment
    assert.ok(increment.kind !== 'read' && increment.handler)
    assert.deepEqual(increment.needs, { config: { node: '../config' } })
    const receiver = { value: 7 }
    assert.deepEqual(await increment.handler.call(receiver, context, 3), { value: 10, needs: context.needs })
    assert.equal(context.node.value, 1)
    const count = registry.type('manifest.item').actions.count
    assert.ok(count.kind === 'read')
    const stream = count.handler.call(receiver, context, undefined)
    assert.ok('next' in stream)
    assert.deepEqual(await stream.next(), { value: 10, done: false })
    assert.deepEqual(await stream.next(), { value: 11, done: true })
  })

  it('stores native security handlers separately from all legacy contexts', async () => {
    class Capability {}
    const rule = () => 7
    const mount = async () => { throw new Error('unused') }
    const service = async () => ({ stop: async () => {} })
    const derive = async () => ({ members: [] })
    const manifest = await collectModule('capabilities', () => {
      registerType('manifest.capability', Capability, { security: 'user-capability' })
      schema('manifest.capability')
      const before = getRegistryVersion()
      registerKernel(Capability, 'acl', rule)
      registerKernel(Capability, 'migrate', [])
      registerKernel(Capability, 'mount', mount)
      registerKernel(Capability, 'service', service)
      registerKernel(Capability, 'derive', derive)
      assert.equal(getRegistryVersion(), before)
      for (const name of ['acl', 'migrate', 'mount', 'service', 'derive']) assert.equal(resolveExact(Capability, name), null)
    })
    assert.deepEqual(manifest.legacySecurity, [])
    assert.equal(manifest.security.length, 5)
    const registry = createRegistry()
    publishModules(registry, [manifest])
    assert.equal(registry.type('manifest.capability').security, 'user-capability')
    assert.equal(registry.security('manifest.capability', 'acl'), rule)
    assert.equal(registry.security('manifest.capability', 'mount'), mount)
    assert.equal(registry.security('manifest.capability', 'service'), service)
    assert.equal(registry.security('manifest.capability', 'derive'), derive)
  })

  it('keeps the first security class of a sealed type declaration', async () => {
    class Item {}
    const manifest = await collectModule('sealed', () => {
      registerType('manifest.sealed', Item)
      registerType('manifest.sealed', Item, { security: 'user-capability' })
      schema('manifest.sealed')
    })
    assert.equal(manifest.types[0].security, 'ordinary')
  })

  it('refuses a legacy-only mount before publishing any collected module', async () => {
    const good = await collectModule('good', () => schema('manifest.good'))
    const legacy = async () => { throw new Error('unused') }
    const bad = await collectModule('bad', () => {
      class Capability {}
      registerType('manifest.mount', Capability, { security: 'user-capability' })
      schema('manifest.mount')
      register('manifest.mount', 'mount', legacy)
    })
    assert.equal(resolveExact('manifest.mount', 'mount'), legacy)
    assert.deepEqual(bad.legacySecurity, [{ type: 'manifest.mount', context: 'mount' }])
    assert.equal(bad.open.some(entry => entry.context === 'mount'), false)
    const registry = createRegistry(), before = registry.digest
    assert.throws(() => publishModules(registry, [good, bad]), (error: unknown) =>
      error instanceof KernelError && error.code === 'INVALID' && 'type' in error && error.type === 'manifest.mount' && 'context' in error && error.context === 'mount')
    assert.equal(registry.digest, before)
    assert.throws(() => registry.type('manifest.good'), code('UNKNOWN_TYPE'))
  })

  it('uses the native handler when the same owner also registers legacy security', async () => {
    const native = () => 7
    const legacy = () => [{ g: 'users', p: 1 }]
    const manifest = await collectModule('rights', () => {
      schema('manifest.rights')
      register('manifest.rights', 'acl', legacy)
      registerKernel('manifest.rights', 'acl', native)
    })
    const registry = createRegistry()
    publishModules(registry, [manifest])
    assert.equal(registry.security('manifest.rights', 'acl'), native)
    assert.equal(resolveExact('manifest.rights', 'acl'), legacy)
  })

  it('discards a failed import and retains the last successful module', async () => {
    const first = await collectModule('items', () => schema('manifest.item'))
    const failure = new TypeError('import failed')
    await assert.rejects(() => collectModule('items', () => {
      schema('manifest.discarded')
      throw failure
    }), error => error === failure)
    assert.equal(getCollectedModule('items'), first)
    await assert.rejects(() => collectModule('failed', () => {
      schema('manifest.other')
      throw failure
    }), error => error === failure)
    assert.equal(getCollectedModule('failed'), undefined)
    assertNoAmbientRegistrations()
    const registry = createRegistry()
    publishModules(registry, [first])
    assert.throws(() => registry.type('manifest.discarded'), code('UNKNOWN_TYPE'))
  })

  it('retains a completed import by its source and rejects a changed module identity', async () => {
    const first = await collectModule('owner', () => schema('manifest.origin'), 'source')
    assert.equal(getCollectedModule('owner', 'source'), first)
    assert.equal(getCollectedModule('owner', 'another-source'), undefined)
    assert.throws(() => getCollectedModule('changed-owner', 'source'), code('CONFLICT'))
    const failure = new TypeError('import failed')
    await assert.rejects(() => collectModule('owner', () => { throw failure }, 'source'), error => error === failure)
    assert.equal(getCollectedModule('owner', 'source'), first)
    assert.equal(getCollectedModule('owner'), first)
    clearCollectedModules()
    assert.equal(getCollectedModule('owner', 'source'), undefined)
    assert.equal(getCollectedModule('owner'), undefined)
  })

  it('keeps concurrent asynchronous module imports isolated', async () => {
    const firstGate = gate(), secondGate = gate()
    const first = collectModule('first', async () => {
      schema('manifest.first')
      await firstGate.wait
      registerKernel('manifest.first', 'acl', () => 1)
    })
    const second = collectModule('second', async () => {
      schema('manifest.second')
      await secondGate.wait
      registerKernel('manifest.second', 'acl', () => 3)
    })
    secondGate.release()
    const secondManifest = await second
    firstGate.release()
    const firstManifest = await first
    assert.deepEqual(firstManifest.types.map(type => type.name), ['manifest.first'])
    assert.deepEqual(secondManifest.types.map(type => type.name), ['manifest.second'])
    assert.equal(firstManifest.security[0].type, 'manifest.first')
    assert.equal(secondManifest.security[0].type, 'manifest.second')
    assertNoAmbientRegistrations()
  })

  it('shares collection scope when another core module instance registers handlers', async () => {
    const duplicate: typeof import('./manifest') = await import(new URL('./manifest.ts?second-copy', import.meta.url).href)
    const first = await collectModule('mixed-first', () => {
      schema('manifest.mixed-first')
      duplicate.registerKernel('manifest.mixed-first', 'acl', () => 1)
    })
    const second = await duplicate.collectModule('mixed-second', () => {
      schema('manifest.mixed-second')
      registerKernel('manifest.mixed-second', 'acl', () => 3)
    })
    assert.deepEqual(first.types.map(type => type.name), ['manifest.mixed-first'])
    assert.deepEqual(second.types.map(type => type.name), ['manifest.mixed-second'])
    assert.equal(first.security[0].type, 'manifest.mixed-first')
    assert.equal(second.security[0].type, 'manifest.mixed-second')
    assert.equal(duplicate.getCollectedModule('mixed-first'), first)
    assert.equal(getCollectedModule('mixed-second'), second)
    assertNoAmbientRegistrations()
    duplicate.assertNoAmbientRegistrations()
  })

  it('rejects registration in asynchronous work left after an import finishes', async () => {
    const pending = gate()
    let late: Promise<void> = Promise.resolve()
    await collectModule('closed', () => {
      schema('manifest.closed')
      late = pending.wait.then(() => register('manifest.late', 'text', () => 'late'))
    })
    const rejected = assert.rejects(() => late, code('INVALID'))
    pending.release()
    await rejected
    assert.equal(resolveExact('manifest.late', 'text'), null)
    assertNoAmbientRegistrations()
  })

  it('isolates unscoped test registrations and rejects them at production boot', async () => {
    schema('manifest.ambient')
    assert.throws(assertNoAmbientRegistrations, code('INVALID'))
    const scoped = await collectModule('scoped', () => schema('manifest.scoped'))
    assert.deepEqual(scoped.types.map(type => type.name), ['manifest.scoped'])
    const registry = createRegistry()
    publishModules(registry, [ambientModule(), scoped])
    assert.equal(registry.type('manifest.ambient').module, 'ambient')
    assert.equal(registry.type('manifest.scoped').module, 'scoped')
    clearAmbientRegistrations()
    assertNoAmbientRegistrations()
  })

  it('accepts files only for types declared in the active module', async () => {
    await collectModule('owner', () => {
      class Item {}
      registerType('manifest.owned', Item)
      assertModuleSchema('manifest.owned')
      schema('manifest.owned')
      assert.throws(() => assertModuleSchema('manifest.foreign'), code('FORBIDDEN'))
    })
    assert.equal(getCollectedModule('owner')?.types[0].name, 'manifest.owned')
  })

  it('keeps sealed registrations and applies explicit replacement or removal', async () => {
    const first = () => 'first', second = () => 'second', replacement = () => 'replacement'
    const manifest = await collectModule('bindings', () => {
      schema('manifest.bound')
      register('manifest.bound', 'text', first)
      register('manifest.bound', 'text', second)
      register('manifest.bound', 'react', first)
      replaceHandler('manifest.bound', 'react', replacement)
      register('manifest.bound', 'removed', first)
      unregister('manifest.bound', 'removed')
    })
    const registry = createRegistry()
    publishModules(registry, [manifest])
    assert.equal(registry.handler('manifest.bound', 'text'), first)
    assert.equal(registry.handler('manifest.bound', 'react'), replacement)
    assert.equal(registry.handler('manifest.bound', 'removed'), undefined)
  })

  it('compiles native direct actions and permits an open action on a foreign type', async () => {
    const action = { kind: 'read' as const, args: { type: 'number' }, handler: async (_context: ReadActionContext, value: unknown) => value }
    const owner = await collectModule('owner', () => {
      schema('manifest.direct', { methods: { run: { kind: 'read', arguments: [{ name: 'value', type: 'number' }] } } })
      registerKernelAction('manifest.direct', 'run', action)
    })
    const foreign = await collectModule('foreign', () => registerKernelAction('manifest.direct', 'extra', action))
    const registry = createRegistry()
    publishModules(registry, [owner, foreign])
    assert.deepEqual(registry.type('manifest.direct').actions.run.args, { type: 'number' })
    assert.equal(registry.type('manifest.direct').actions.run.handler, action.handler)
    assert.equal(registry.handler('manifest.direct', 'action:extra'), action)
    assert.equal(resolveExact('manifest.direct', 'action:run'), null)
  })

  it('refuses unsupported legacy actions and unmatched schema methods loudly', async () => {
    const legacy = await collectModule('legacy', () => register('manifest.action', 'action:run', async () => 1))
    assert.deepEqual(legacy.legacyActions, [{ type: 'manifest.action', name: 'run' }])
    assert.throws(() => publishModules(createRegistry(), [legacy]), code('INVALID'))
    await assert.rejects(() => collectModule('stale', () => schema('manifest.stale', { methods: { run: { arguments: [] } } })), code('INVALID'))
    assert.equal(getCollectedModule('stale'), undefined)
  })

  it('validates direct action expressions and duplicate declarations', async () => {
    await assert.rejects(() => collectModule('unsafe', () => {
      schema('manifest.unsafe')
      registerKernelAction('manifest.unsafe', 'run', { kind: 'read', args: {}, pre: { $regex: '.*' }, handler: async () => 1 })
    }), code('INVALID'))
    await assert.rejects(() => collectModule('duplicate', () => {
      registerKernel('manifest.duplicate', 'acl', () => 1)
      registerKernel('manifest.duplicate', 'acl', () => 3)
    }), code('CONFLICT'))
    await assert.rejects(() => collectModule('duplicate-action', () => {
      registerKernelAction('manifest.duplicate', 'run', { kind: 'read', args: {}, handler: async () => 1 })
      registerKernelAction('manifest.duplicate', 'run', { kind: 'read', args: {}, handler: async () => 2 })
    }), code('CONFLICT'))
  })

  it('publishes only the kernel-owned builtins without the moved or session type', () => {
    const registry = createRegistry()
    registry.publish(kernelManifest)
    for (const type of ['t.dir', 't.root', 't.ref', 't.type', 't.mount-point']) assert.equal(registry.type(type).module, 'kernel')
    assert.throws(() => registry.type('t.moved'), code('UNKNOWN_TYPE'))
    assert.throws(() => registry.type('t.session'), code('UNKNOWN_TYPE'))
  })
})
