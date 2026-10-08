import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mapRegistry, register, registerLegacy, resolveExactEntry, unregister } from '#core/registry'
import { clearAmbientRegistrations } from '#kernel/manifest'
import { createRegistry } from '#kernel/registry'
import { clearRegistry, publishAmbientModule } from '#testing'

describe('native ambient test registries', () => {
  let restore: () => void
  beforeEach(() => {
    const previous = mapRegistry((type, context) => ({ type, context, entry: resolveExactEntry(type, context)! }))
    clearRegistry()
    restore = () => {
      mapRegistry((type, context) => { unregister(type, context) })
      clearAmbientRegistrations()
      for (const { type, context, entry } of previous) registerLegacy(type, context, entry.handler, entry.meta)
    }
  })
  afterEach(() => restore())

  it('publishes ambient declarations into independent test registries', () => {
    const properties = { value: { type: 'number' } }
    register('test.ambient', 'schema', () => ({ type: 'object', properties }))
    const first = createRegistry(), second = createRegistry()
    publishAmbientModule(first)
    publishAmbientModule(second)
    assert.equal(first.type('test.doc').module, 'ambient')
    assert.equal(first.type('test.ambient').module, 'ambient')
    assert.equal(first.digest, second.digest)
    properties.value.type = 'string'
    publishAmbientModule(second)
    assert.deepEqual(first.type('test.ambient').schema, { type: 'object', properties: { value: { type: 'number' } } })
    assert.deepEqual(second.type('test.ambient').schema, { type: 'object', properties: { value: { type: 'string' } } })
    assert.notEqual(first.digest, second.digest)
  })
})
