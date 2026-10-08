import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createProjector } from '#kernel/projection'
import { createRegistry } from '#kernel/registry'
import { A, R, W, type Component, type JsonSchema, type RightsRule, type StoredNode } from '#kernel/types'

const stored = (fields: Record<string, unknown> = {}): StoredNode => ({
  $id: 'id', $path: '/item', $type: 'doc', $pos: { instance: 'test', epoch: 1, seq: 1 }, $v: 1, ...fields,
})
function fixture() {
  const registry = createRegistry(), alerts: { path: string; code: string }[] = []
  const publish = (version = 1, up = (component: Component): Component => ({ ...component, value: 'migrated' }),
    rule: RightsRule = () => R | W | A, schema: JsonSchema = {}) => registry.publish({ id: 'test', open: [], types: [
      { name: 'doc', module: 'test', security: 'ordinary', version, schema, actions: {} },
      { name: 'plain', module: 'test', security: 'ordinary', version: 0, schema: {}, actions: {} },
    ], security: [
      { type: 'doc', context: 'acl', handler: rule },
      { type: 'doc', context: 'migrate', handler: Array.from({ length: version }, (_, from) => ({ from, to: from + 1, up })) },
    ] })
  publish()
  const project = createProjector({ registry, alert: (path, error) => alerts.push({ path, code: error.code }) })
  return { registry, alerts, publish, project }
}

describe('node projections', () => {
  it('hides ACL and owner without A and keeps them with A, preserving the stored image', () => {
    const f = fixture(), before = stored({ value: 'hello', $acl: [{ subject: { group: 'users' }, grant: R }], $owner: 'u:owner' })
    const original = structuredClone(before), ordinary = f.project(before, R), admin = f.project(before, R | A)
    assert.ok(ordinary && 'node' in ordinary && admin && 'node' in admin)
    assert.equal(Object.hasOwn(ordinary.node, '$acl'), false); assert.equal(Object.hasOwn(ordinary.node, '$owner'), false)
    assert.deepEqual(admin.node.$acl, before.$acl); assert.equal(admin.node.$owner, before.$owner)
    assert.equal(ordinary.bits, R); assert.equal(Object.hasOwn(admin.node, '$pos'), false)
    assert.equal(typeof ordinary.node.$rev, 'string'); assert.deepEqual(before, original)
    assert.notEqual(ordinary.ver, admin.ver)
  })

  it('returns absence without R, including for malformed data, without raising visible-node alerts', () => {
    const f = fixture()
    assert.equal(f.project(stored({ '#broken': 7 }), 0), null)
    assert.equal(f.project(stored(), W | A), null); assert.deepEqual(f.alerts, [])
  })

  it('changes projection versions with position, bits, migration and rule generations', () => {
    const f = fixture(), before = stored(), initial = f.project(before, R)!
    assert.notEqual(initial.ver, f.project(before, R | W)!.ver)
    assert.notEqual(initial.ver, f.project({ ...before, $pos: { ...before.$pos, seq: 2 } }, R)!.ver)
    f.publish(2)
    const migrated = f.project(before, R)!
    assert.ok('node' in migrated); assert.equal(migrated.node.$v, 2); assert.notEqual(migrated.ver, initial.ver)
    const other = (component: Component) => ({ ...component, other: true })
    f.publish(2, other)
    const changed = f.project(before, R)!
    assert.notEqual(changed.ver, migrated.ver)
    f.publish(2, other, () => R)
    assert.notEqual(f.project(before, R)!.ver, changed.ver)
  })

  it('keeps a type projection version when another module publishes UI or migration handlers', () => {
    const f = fixture(), before = stored(), initial = f.project(before, R)!
    f.registry.publish({ id: 'other', types: [{ name: 'other', module: 'other', security: 'ordinary', version: 1, schema: {}, actions: {} }],
      open: [{ type: 'other', context: 'react', handler: () => 'view' }],
      security: [{ type: 'other', context: 'migrate', handler: [{ from: 0, to: 1, up: component => component }] }] })
    assert.equal(f.project(before, R)!.ver, initial.ver)
  })

  it('isolates a failed migration to its node and carries stored sort values without hidden fields', t => {
    t.mock.method(console, 'error', () => {})
    const f = fixture()
    f.publish(1, component => { Reflect.set(component, 'score', 99); throw new Error('broken migration') })
    const before = stored({ $v: 0, score: 2, $owner: 'u:owner', nested: { rank: 7 } })
    const copies = [before, stored({ $id: 'other', $path: '/good', $type: 'plain', $v: 0, score: 3 })]
      .map(node => f.project(node, R, [['score', 1], ['nested.rank', 1], ['$owner', 1]]))
    const bad = copies[0], good = copies[1]
    assert.ok(bad && 'error' in bad && good && 'node' in good)
    assert.equal(bad.error.code, 'INVALID'); assert.equal(bad.id, before.$id); assert.equal(bad.path, before.$path)
    assert.deepEqual(bad.sort, { score: 2, 'nested.rank': 7, $owner: undefined })
    assert.equal(good.node.score, 3); assert.equal(before.score, 2)
    assert.deepEqual(f.alerts, [{ path: '/item', code: 'INVALID' }])
  })

  it('reports one schema-invalid node while valid nodes remain readable', t => {
    t.mock.method(console, 'error', () => {})
    const f = fixture()
    f.publish(1, component => component, () => R, { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] })
    const bad = f.project(stored({ value: 7 }), R), good = f.project(stored({ value: 'valid' }), R)
    assert.ok(bad && 'error' in bad && good && 'node' in good)
    assert.equal(bad.error.code, 'INVALID'); assert.equal(good.node.value, 'valid'); assert.equal(f.alerts.length, 1)
    assert.notEqual(f.project(stored({ value: 'valid', $pos: { instance: 'test', epoch: 1, seq: 2 } }), R)!.ver, bad.ver)
  })

  it('hides an unregistered component type and alerts instead of returning a partial node', t => {
    t.mock.method(console, 'error', () => {})
    const f = fixture()
    assert.equal(f.project(stored({ '#unknown': { $type: 'unknown' } }), R), null)
    assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0].path, '/item')
  })

  it('validates composition at the component schema root without counting node metadata as extra fields', t => {
    t.mock.method(console, 'error', () => {})
    const f = fixture()
    f.publish(1, component => component, () => R, { allOf: [
      { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    ] })
    const bad = f.project(stored({ value: 7 }), R), good = f.project(stored({ value: 'valid' }), R)
    assert.ok(bad && 'error' in bad && good && 'node' in good)
    assert.equal(bad.error.code, 'INVALID'); assert.equal(good.node.value, 'valid')
  })
})
