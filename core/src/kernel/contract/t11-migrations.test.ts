import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createMigrator, type MigrationSource } from '#kernel/migrate'
import type { Component, StoredNode } from '#kernel/types'

const invalid = (error: unknown) => error instanceof KernelError && error.code === 'INVALID'
const node = (fields: Record<string, unknown> = {}): StoredNode => ({
  $id: 'id', $path: '/item', $type: 'doc', $pos: { instance: 'test', epoch: 1, seq: 1 }, ...fields,
})
const rename = (input: Component): Component => {
  const { text, ...fields } = input
  return { ...fields, body: text }
}

describe('component migration contracts', () => {
  it('gives each step only its own component, preserving node metadata and other components', () => {
    const seen: string[][] = []
    const sources = new Map<string, MigrationSource>([
      ['doc', { version: 1, steps: [{ from: 0, to: 1, up: component => { seen.push(Object.keys(component)); return rename(component) } }] }],
      ['note', { version: 1, steps: [{ from: 0, to: 1, up: component => { const { old, ...fields } = component; return { ...fields, note: old } } }] }],
    ])
    const migrate = createMigrator(type => sources.get(type))
    const before = node({ text: 'hello', $acl: [], $owner: 'u:owner', '#note': { $type: 'note', old: 7 } })
    const original = structuredClone(before), after = migrate.migrate(before)
    assert.equal(after.body, 'hello'); assert.equal(Object.hasOwn(after, 'text'), false)
    assert.deepEqual(after['#note'], { $type: 'note', note: 7, $v: 1 })
    assert.ok(seen[0].every(key => !key.startsWith('#') && !['$id', '$path', '$pos', '$acl', '$owner'].includes(key)))
    assert.equal(after.$id, before.$id); assert.equal(after.$path, before.$path)
    assert.deepEqual(after.$pos, before.$pos); assert.deepEqual(after.$acl, before.$acl); assert.equal(after.$owner, before.$owner)
    assert.deepEqual(before, original)
  })

  it('chooses steps by each stored version while bare type-bearing values stay data', () => {
    let first = 0
    const source: MigrationSource = { version: 2, steps: [
      { from: 0, to: 1, up: component => { first++; return rename(component) } },
      { from: 1, to: 2, up: component => ({ ...component, words: 1 }) },
    ] }
    const migrator = createMigrator(type => type === 'doc' ? source : undefined)
    const before = node({ $v: 1, body: 'hello', snapshot: { $type: 'doc', text: 'snapshot' }, '#other': { $type: 'plain', value: 1 } })
    const after = migrator.migrate(before)
    assert.equal(first, 0); assert.equal(after.$v, 2); assert.equal(after.words, 1)
    assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after['#other'], before['#other'])
  })

  it('keeps converged objects checked when an unrelated type changes and invalidates only a changed ladder', () => {
    let runs = 0
    const first = { from: 0, to: 1, up: (component: Component) => { runs++; return rename(component) } }
    const sources = new Map<string, MigrationSource>([['doc', { version: 1, steps: [first] }]])
    const migrator = createMigrator(type => sources.get(type))
    const once = migrator.migrate(node({ text: 'hello' })), version = migrator.version('doc')
    sources.set('other', { version: 1, steps: [first] })
    assert.equal(migrator.migrate(once), once); assert.equal(migrator.version('doc'), version); assert.equal(runs, 1)
    sources.set('doc', { version: 2, steps: [first, { from: 1, to: 2, up: component => ({ ...component, more: true }) }] })
    const twice = migrator.migrate(once)
    assert.notEqual(migrator.version('doc'), version); assert.equal(twice.$v, 2); assert.equal(twice.more, true)
    assert.equal(runs, 1); assert.equal(migrator.migrate(twice), twice)
  })

  it('stamps current input without executing migrations and rejects stale input atomically', () => {
    let runs = 0
    const migrator = createMigrator(() => ({ version: 1, steps: [{ from: 0, to: 1, up: component => { runs++; return component } }] }))
    const fresh = node({ body: 'current', '#note': { $type: 'note', note: 'current' } })
    migrator.stamp(fresh)
    assert.equal(fresh.$v, 1); assert.equal(fresh['#note'].$v, 1); assert.equal(runs, 0)
    const stale = node({ '#note': { $type: 'note', $v: 0 } }), original = structuredClone(stale)
    assert.throws(() => migrator.stamp(stale), invalid)
    assert.deepEqual(stale, original)
  })

  it('rejects unavailable, future, fractional and ambiguous migration paths loudly', () => {
    const gap = createMigrator(() => ({ version: 2, steps: [{ from: 1, to: 2, up: rename }] }))
    assert.throws(() => gap.migrate(node()), invalid)
    for (const version of [-1, 0.5, 3]) assert.throws(() => gap.migrate(node({ $v: version })), invalid)
    const ambiguous = createMigrator(() => ({ version: 2, steps: [{ from: 0, to: 1, up: rename }, { from: 0, to: 2, up: rename }] }))
    assert.throws(() => ambiguous.migrate(node()), invalid)
  })

  it('rejects steps that change identity or inject node metadata and named components', () => {
    for (const fields of [{ $type: 'other' }, { $id: 'other' }, { $path: '/other' }, { '#hidden': { $type: 'note' } }]) {
      const migrator = createMigrator(() => ({ version: 1, steps: [{ from: 0, to: 1, up: component => ({ ...component, ...fields }) }] }))
      assert.throws(() => migrator.migrate(node()), invalid)
    }
  })

  it('passes through types without migrations and rejects malformed named components', () => {
    const migrator = createMigrator(() => undefined), before = node({ value: 1 })
    assert.equal(migrator.migrate(before), before)
    assert.throws(() => migrator.migrate(node({ '#broken': 7 })), invalid)
  })
})
