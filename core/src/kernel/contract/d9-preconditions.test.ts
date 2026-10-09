import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { createInfluenceIndex, createInfluenceTest, type InfluenceContext } from '#kernel/influence'
import { positionToRev } from '#kernel/position'
import { checkPreconditions, rightsReadInput, typeReadVersion, type PreconditionOptions, type ReadDependency, type ReadSet } from '#kernel/preconditions'
import { R, W, type Actor, type Node, type Position, type Selector, type StoredNode } from '#kernel/types'

const pos = (seq: number, epoch = 1): Position => ({ instance: 'test', epoch, seq })
const node = (path: string, fields: Record<string, unknown> = {}, seq = 0): StoredNode => ({
  ...fields, $id: path, $path: path, $type: 'item', $v: 1, $pos: pos(seq),
})
const project = (stored: StoredNode): Node => { const { $pos, ...fields } = stored; return { ...fields, $rev: positionToRev($pos) } }
const context = (): InfluenceContext => ({ project, work: { limit: 100_000, used: 0 } })
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const index = (options: { maxWrites?: number; maxBytes?: number } = {}) => createInfluenceIndex({ position: pos(0), domains: ['memory', 'other'], ...options })
const selector: Selector = { children: '/slots', where: { active: true } }
const actor: Actor = { principal: 'u:alice', claims: ['u:alice', 'users'] }
const who = (expect?: ReadSet) => ({ executor: actor.principal, caller: actor.principal, actor, expect })
async function setup() {
  const f = await fixture()
  await f.commit([put('/', { $acl: [{ subject: { group: 'users' }, grant: R | W }] }, 'dir'), put('/slots', {}, 'dir')])
  return f
}
async function unchanged(f: Awaited<ReturnType<typeof fixture>>, expect: ReadSet) {
  const before = await f.nodes(), journal = await f.journal()
  await assert.rejects(f.commit([put('/written')], who(expect)), code('CONFLICT'))
  assert.deepEqual(await f.nodes(), before); assert.deepEqual(await f.journal(), journal)
}

describe('selector influence', () => {
  it('covers exact nodes, direct children and recursive history ranges', () => {
    const write = {
      domain: 'memory',
      path: '/slots/deep/item',
      pos: pos(1),
      before: null,
      after: node('/slots/deep/item'),
    };
    assert.equal(createInfluenceTest({ node: '/slots/deep/item' }, context())(write), true);
    assert.equal(createInfluenceTest({ node: '/slots' }, context())(write), false);
    assert.equal(createInfluenceTest({ children: '/slots' }, context())(write), false);
    assert.equal(
      createInfluenceTest(
        { history: '/slots' },
        {
          ...context(),
          historyVisible: (change) =>
            change.after !== null && project(change.after) !== null,
        },
      )({
        ...write,
        transition: { id: write.after.$id, before: write.before, after: write.after },
      }),
      true,
    );
  });

  it('counts both entry into and exit from a filter', () => {
    const affects = createInfluenceTest(selector, context())
    const base = { domain: 'memory', path: '/slots/item', pos: pos(1) }
    assert.equal(affects({ ...base, before: node(base.path, { active: false }), after: node(base.path, { active: true }) }), true)
    assert.equal(affects({ ...base, before: node(base.path, { active: true }), after: node(base.path, { active: false }) }), true)
    assert.equal(affects({ ...base, before: node(base.path, { active: false }), after: node(base.path, { active: false, value: 7 }) }), false)
  })

  it('applies visibility and hidden metadata removal before the filter', () => {
    const ctx: InfluenceContext = { ...context(), project: stored => {
      if (stored.hidden === true) return null
      const { $owner, $acl, ...visible } = project(stored)
      return visible
    } }
    const write = { domain: 'memory', path: '/slots/item', pos: pos(1), before: null,
      after: node('/slots/item', { hidden: true, active: true, $owner: 'u:bob' }) }
    assert.equal(createInfluenceTest(selector, ctx)(write), false)
    assert.equal(createInfluenceTest({ children: '/slots', where: { $owner: 'u:bob' } }, ctx)({ ...write, after: { ...write.after, hidden: false } }), false)
  })

  it('charges the shared expression budget while testing writes', () => {
    const affects = createInfluenceTest({ children: '/slots', where: { values: { $elemMatch: { value: 99 } } } },
      { project, work: { limit: 2, used: 0 } })
    assert.throws(() => affects({ domain: 'memory', path: '/slots/item', pos: pos(1), before: null,
      after: node('/slots/item', { values: [{ value: 1 }, { value: 2 }, { value: 3 }] }) }), code('BUDGET'))
  })

  it('routes a move to both its old and new ranges', () => {
    const history = index()
    history.record('memory', pos(1), [{ id: 'item', before: node('/old/item'), after: node('/new/item') }])
    for (const children of ['/old', '/new']) assert.throws(() => history.check({ children }, [pos(0)], pos(2), ['memory'], context()), code('CONFLICT'))
    assert.doesNotThrow(() => history.check({ children: '/elsewhere' }, [pos(0)], pos(2), ['memory'], context()))
  })

  it('excludes both interval endpoints and leaves unrelated domains unaffected', () => {
    const history = index()
    history.record('memory', pos(1), [{ id: 'one', before: null, after: node('/slots/one', { active: true }) }])
    history.record('memory', pos(2), [{ id: 'two', before: null, after: node('/slots/two', { active: true }) }])
    assert.doesNotThrow(() => history.check(selector, [pos(1)], pos(2), ['memory'], context()))
    assert.doesNotThrow(() => history.check(selector, [pos(0)], pos(3), ['other'], context()))
  })

  it('uses the earliest position when one selector read its sources at different times', () => {
    const history = index()
    history.record('memory', pos(1), [{ id: 'item', before: null, after: node('/slots/item', { active: true }) }])
    history.advance(pos(2))
    assert.throws(() => history.check(selector, [pos(2), pos(0)], pos(3), ['memory'], context()), code('CONFLICT'))
  })

  it('rejects intervals shorter than the retained write history only in affected domains', () => {
    const history = index({ maxWrites: 1 })
    for (const seq of [1, 2]) history.record('memory', pos(seq), [{ id: String(seq), before: null, after: node(`/slots/${seq}`, { active: false }) }])
    assert.equal(history.size, 1)
    assert.throws(() => history.check(selector, [pos(0)], pos(3), ['memory'], context()), code('CONFLICT'))
    assert.doesNotThrow(() => history.check(selector, [pos(0)], pos(3), ['other'], context()))
    assert.doesNotThrow(() => history.check(selector, [pos(1)], pos(3), ['memory'], context()))
  })

  it('bounds retained image bytes and rejects a truncated interval', () => {
    const history = index({ maxBytes: 64 })
    history.record('memory', pos(1), [{ id: 'large', before: null, after: node('/slots/large', { value: 'x'.repeat(1000) }) }])
    assert.ok(history.bytes <= 64)
    assert.throws(() => history.check(selector, [pos(0)], pos(2), ['memory'], context()), code('CONFLICT'))
  })

  it('keeps declared gaps continuous and refuses skipped positions or a previous writer epoch', () => {
    const history = index()
    history.advance(pos(1))
    assert.doesNotThrow(() => history.check(selector, [pos(0)], pos(2), ['memory'], context()))
    history.advance(pos(3))
    assert.throws(() => history.check(selector, [pos(0)], pos(4), ['memory'], context()), code('CONFLICT'))
    const restarted = createInfluenceIndex({ position: pos(0, 2), domains: ['memory'] })
    restarted.advance(pos(1, 2))
    assert.throws(() => restarted.check(selector, [pos(99, 1)], pos(2, 2), ['memory'], context()), code('CONFLICT'))
  })

  it('loses continuity for one reset domain and retains it for others', () => {
    const history = index()
    history.advance(pos(1)); history.reset('memory', pos(2))
    assert.throws(() => history.check(selector, [pos(1)], pos(3), ['memory'], context()), code('CONFLICT'))
    assert.doesNotThrow(() => history.check(selector, [pos(1)], pos(3), ['other'], context()))
  })

  it('owns unfrozen images so later caller edits cannot alter recorded influence', () => {
    const history = index(), state = { ready: true }
    history.record('memory', pos(1), [{ id: 'item', before: null, after: node('/slots/item', { state }) }])
    state.ready = false
    assert.throws(() => history.check({ children: '/slots', where: { 'state.ready': true } }, [pos(0)], pos(2), ['memory'], context()), code('CONFLICT'))
  })
})

describe('read-set preconditions', () => {
  it('lets exactly one concurrent booking commit against the same empty selector', async () => {
    const f = await setup(), at = [f.writer.stream.cursor().pos]
    const expect: ReadSet = { selectors: [{ selector, at }] }
    const results = await Promise.allSettled([
      f.commit([put('/slots/one', { active: true })], who(expect)),
      f.commit([put('/slots/two', { active: true })], who(expect)),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')!
    assert.equal(rejected.status, 'rejected')
    if (rejected.status === 'rejected') assert.ok(code('CONFLICT')(rejected.reason))
    assert.equal((await f.nodes()).filter(node => node.$path.startsWith('/slots/')).length, 1)
  })

  it('checks node revisions and visible absences in the executor projection', async () => {
    const f = await setup()
    await f.commit([put('/slots/item', { value: 1 }), put('/hidden', { $acl: [{ subject: { group: 'users' }, deny: R }] })])
    const item = (await f.nodes()).find(node => node.$path === '/slots/item')!
    await f.commit([], who({ nodes: [{ path: item.$path, rev: positionToRev(item.$pos) }], absent: ['/hidden', '/missing'] }))
    await unchanged(f, { absent: ['/slots/item'] })
    await unchanged(f, { nodes: [{ path: '/hidden', rev: 'opaque' }] })
    await unchanged(f, { nodes: [{ path: '/missing', rev: 'opaque' }] })
    await f.commit([{ op: 'patch', path: item.$path, ops: { $set: { value: 2 } } }])
    await unchanged(f, { nodes: [{ path: item.$path, rev: positionToRev(item.$pos) }] })
  })

  it('passes a non-affecting write and refuses a write entering the selector filter', async () => {
    const f = await setup(), at = [f.writer.stream.cursor().pos]
    await f.commit([put('/slots/item', { active: false })])
    await f.commit([put('/outside')], who({ selectors: [{ selector, at }] }))
    await f.commit([{ op: 'patch', path: '/slots/item', ops: { $set: { active: true } } }])
    await unchanged(f, { selectors: [{ selector, at }] })
  })

  it('ignores ordinary ancestor fields but notices ACL, owner and rule-bearing type inputs', async () => {
    const f = await setup(), root = (await f.nodes()).find(node => node.$path === '/')!
    const dependency: ReadDependency = { kind: 'rights', key: '/', value: rightsReadInput(root, f.registry) }
    await f.commit([{ op: 'patch', path: '/', ops: { $set: { title: 'changed', '#extra': { $type: 'extra' } } } }])
    await f.commit([], who({ dependencies: [dependency] }))
    await f.commit([{ op: 'patch', path: '/', ops: { $set: { $owner: 'u:bob' } } }])
    await unchanged(f, { dependencies: [dependency] })

    const current = async (): Promise<ReadDependency> => ({ kind: 'rights', key: '/',
      value: rightsReadInput((await f.nodes()).find(node => node.$path === '/')!, f.registry) })
    const owner = await current()
    await f.commit([{ op: 'patch', path: '/', ops: { $set: {
      $acl: [{ subject: { group: 'users' }, grant: R | W }, { subject: { group: 'other' }, grant: R }],
    } } }])
    await unchanged(f, { dependencies: [owner] })

    f.registry.publish({ id: 'policy', open: [],
      security: [{ type: 'limited', context: 'acl', handler: () => R | W }],
      types: [{ name: 'limited', aliases: ['old.limited'], module: 'policy', security: 'ordinary', version: 0, schema: {}, actions: {} }],
    })
    const acl = await current()
    await f.commit([{ op: 'patch', path: '/', ops: { $set: { '#policy': { $type: 'limited' } } } }])
    await unchanged(f, { dependencies: [acl] })
    const policy = await current()
    await f.commit([{ op: 'patch', path: '/', ops: { $set: { '#policy': { $type: 'old.limited' } } } }])
    await f.commit([], who({ dependencies: [policy] }))
  })

  it('rejects a read type migration change while unrelated module publication stays valid', async () => {
    const f = await setup()
    const dependency: ReadDependency = { kind: 'type', key: 'item', value: typeReadVersion(f.registry, 'item') }
    f.registry.publish({ id: 'elsewhere', open: [], security: [], types: [
      { name: 'unrelated', module: 'elsewhere', security: 'ordinary', version: 0, schema: {}, actions: {} },
    ] })
    await f.commit([], who({ dependencies: [dependency] }))
    const types = ['item', 'extra', 'dir', 'other'].map(name => f.registry.type(name))
    f.registry.publish({ id: 'test', open: [], types: types.map(type => type.name === 'item' ? { ...type, version: 2 } : type),
      security: [{ type: 'item', context: 'migrate', handler: [{ from: 1, to: 2, up: component => component }] }] })
    await unchanged(f, { dependencies: [dependency] })
  })

  it('rejects changed target, actor and domain continuity tokens before checking selectors', async () => {
    const history = index()
    const values = new Map<string, unknown>([['target', { domain: 'old' }], ['actor', { ...actor }], ['epoch', 'old']])
    const options: PreconditionOptions = { ...context(), index: history, position: pos(1), read: async () => null,
      domains: () => ['memory'], dependency: input => values.get(input.kind) }
    for (const kind of ['target', 'actor', 'epoch'] as const) {
      const read: ReadDependency = { kind, key: '/slots', value: structuredClone(values.get(kind)) }
      values.set(kind, 'changed')
      await assert.rejects(checkPreconditions({ dependencies: [read] }, options), code('CONFLICT'))
    }
  })

  it('records missing type dependencies so publication cannot silently open an old hidden result', async () => {
    const f = await setup()
    const dependency: ReadDependency = { kind: 'type', key: 'new.type', value: typeReadVersion(f.registry, 'new.type') }
    f.registry.publish({ id: 'new', open: [], security: [], types: [
      { name: 'new.type', module: 'new', security: 'ordinary', version: 0, schema: {}, actions: {} },
    ] })
    await unchanged(f, { dependencies: [dependency] })
  })
})
