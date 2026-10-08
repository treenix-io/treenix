import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createChainIndex, decodeChainNode, type ChainInput } from '#kernel/chain-index'
import { createRegistry } from '#kernel/registry'
import { computeRights } from '#kernel/rights'
import { A, R, W, type AclEntry, type Actor, type Principal, type Registry, type RightsRule } from '#kernel/types'

const ALL = R | W | A
const grant = (group: string, bits: number): AclEntry => ({ subject: { group }, grant: bits })
const deny = (group: string, bits: number): AclEntry => ({ subject: { group }, deny: bits })
const ownerGrant = (bits: number): AclEntry => ({ subject: { owner: true }, grant: bits })
const input = (path: string, fields: Record<string, unknown> = {}, type = 'test.node'): ChainInput => ({
  ...fields, $path: path, $id: `id:${path}`, $type: type,
})
const actor = (claims: readonly string[] = [], principal: Principal = 'u:alice'): Actor => ({ principal, claims: [principal, ...claims] })

function registry(rules: Record<string, RightsRule> = {}): Registry {
  const result = createRegistry()
  const names = new Set(['test.node', ...Object.keys(rules)])
  result.publish({ id: 'test', types: [...names].map(name => ({ name, module: 'test', security: 'ordinary', schema: {}, version: 0, actions: {} })),
    security: Object.entries(rules).map(([type, handler]) => ({ type, context: 'acl', handler })), open: [],
  })
  return result
}

const evaluate = (nodes: readonly ChainInput[], who = actor(['readers']), types = registry()) =>
  computeRights(who, nodes.map(decodeChainNode), types)

describe('node rights', () => {
  it('denies by default and combines grants from different claims per bit', () => {
    assert.equal(evaluate([input('/')]).bits, 0)
    const result = evaluate([input('/', { $acl: [grant('readers', R), grant('writers', W)] })], actor(['readers', 'writers']))
    assert.equal(result.bits, R | W)
    assert.equal(result.prefix.admin, false)
    assert.deepEqual(result.alerts, [])
  })

  it('keeps a deny sticky across descendants and other granting groups', () => {
    const result = evaluate([
      input('/', { $acl: [grant('readers', R | W)] }),
      input('/p', { $acl: [deny('blocked', W)] }),
      input('/p/a', { $acl: [grant('writers', W)] }),
    ], actor(['readers', 'blocked', 'writers']))
    assert.equal(result.bits, R)
    assert.equal(result.prefix.denied, W)
  })

  it('honours denies at the same node that grants A', () => {
    const result = evaluate([input('/', { $acl: [grant('readers', ALL), deny('readers', A)] }),
      input('/p', { $acl: [deny('readers', W)] })])
    assert.equal(result.bits, R)
    assert.equal(result.prefix.admin, false)
    assert.equal(result.prefix.aboveA, false)
  })

  it('does not let a delegated deny lock out a strict ancestor A-holder', () => {
    const result = evaluate([input('/', { $acl: [grant('readers', ALL)] }),
      input('/team', { $acl: [deny('readers', ALL)] }), input('/team/vault')])
    assert.equal(result.bits, ALL)
    assert.equal(result.prefix.admin, true)
    assert.equal(result.prefix.denied, 0)
  })

  it('distinguishes delegated A from root admin', () => {
    const result = evaluate([input('/', { $acl: [grant('readers', R)] }),
      input('/team', { $acl: [grant('readers', A | W)] }), input('/team/vault', { $acl: [deny('readers', ALL)] })])
    assert.equal(result.bits, ALL)
    assert.equal(result.prefix.aboveA, true)
    assert.equal(result.prefix.admin, false)
  })

  it('resolves owner at each ACL entry instead of rebinding ancestor grants', () => {
    const nodes = [input('/', { $owner: 'u:alice', $acl: [ownerGrant(R)] }),
      input('/p', { $owner: 'u:bob', $acl: [ownerGrant(W)] }), input('/p/a')]
    assert.equal(evaluate(nodes, actor()).bits, R)
    const bob = evaluate(nodes, actor([], 'u:bob'))
    assert.equal(bob.bits, W)
    assert.equal(bob.prefix.owner, 'u:bob')
  })

  it('ANDs the main and every named component rule, including for admin', () => {
    const types = registry({ 'test.main': () => R | W, 'test.part': () => R })
    const result = evaluate([input('/', { $acl: [grant('readers', ALL)] }),
      input('/p', { '#part': { $type: 'test.part' } }, 'test.main')], actor(['readers']), types)
    assert.equal(result.bits, R)
    assert.equal(result.prefix.admin, true)
  })

  it('does not let a type rule grant a missing ACL bit', () => {
    const types = registry({ 'test.open': () => ALL })
    assert.equal(evaluate([input('/', {}, 'test.open')], actor(), types).bits, 0)
  })

  it('gives rules only actor, admin, identity and the nearest owner', () => {
    const who = actor(['readers'])
    let seen = 0
    const types = registry({ 'test.inspect': args => {
      seen++
      assert.deepEqual(Object.keys(args).sort(), ['actor', 'admin', 'id', 'owner'])
      assert.equal(args.actor, who)
      assert.equal(args.admin, true)
      assert.equal(args.id, 'id:/p')
      assert.equal(args.owner, 'u:alice')
      return R
    } })
    const result = evaluate([input('/', { $owner: 'u:alice', $acl: [grant('readers', ALL)] }),
      input('/p', { private: 'data' }, 'test.inspect')], who, types)
    assert.equal(result.bits, R)
    assert.equal(seen, 1)
  })

  it('narrows root A before passing the final admin flag to descendant rules', () => {
    let rootAdmin: boolean | undefined, childAdmin: boolean | undefined
    const types = registry({
      'test.root': args => { rootAdmin = args.admin; return R | W },
      'test.child': args => { childAdmin = args.admin; return ALL },
    })
    const root = input('/', { $acl: [grant('readers', ALL)] }, 'test.root')
    assert.equal(evaluate([root], actor(['readers']), types).bits, R | W)
    const result = evaluate([root, input('/p', { $acl: [deny('readers', R)] }, 'test.child')], actor(['readers']), types)
    assert.equal(rootAdmin, true)
    assert.equal(childAdmin, false)
    assert.equal(result.prefix.admin, false)
    assert.equal(result.bits, W | A)
  })

  it('denies a failed rule and returns its error for an admin alert', () => {
    const error = new Error('Broken rule')
    const types = registry({ 'test.broken': () => { throw error } })
    const result = evaluate([input('/', { $acl: [grant('readers', ALL)] }), input('/p', {}, 'test.broken')], actor(['readers']), types)
    assert.equal(result.bits, 0)
    assert.equal(result.alerts.length, 1)
    assert.equal(result.alerts[0].path, '/p')
    assert.equal(result.alerts[0].error, error)
  })

  it('does not inherit type restrictions as ACL restrictions', () => {
    const types = registry({ 'test.limited': () => R })
    const nodes = [input('/', { $acl: [grant('readers', ALL)] }), input('/p', {}, 'test.limited'), input('/p/a')]
    assert.equal(evaluate(nodes.slice(0, 2), actor(['readers']), types).bits, R)
    assert.equal(evaluate(nodes, actor(['readers']), types).bits, ALL)
  })

  it('uses effective ancestor A after its type rules for the deny exception', () => {
    const types = registry({ 'test.limited': () => R })
    const result = evaluate([input('/', { $acl: [grant('readers', R)] }),
      input('/p', { $acl: [grant('readers', A)] }, 'test.limited'), input('/p/a', { $acl: [deny('readers', ALL)] })], actor(['readers']), types)
    assert.equal(result.bits, 0)
    assert.equal(result.prefix.aboveA, false)
  })

  it('masks R, W and A outside scope, including the admin bit at root', () => {
    const who: Actor = { ...actor(['readers']), scope: ['/allowed'] }
    const root = input('/', { $acl: [grant('readers', ALL)] })
    assert.equal(evaluate([root], who).bits, 0)
    assert.equal(evaluate([root, input('/else')], who).bits, 0)
    const allowed = evaluate([root, input('/allowed', { $acl: [deny('readers', W)] })], who)
    assert.equal(allowed.bits, R | A)
    assert.equal(allowed.prefix.admin, false)
    assert.equal(evaluate([root, input('/allowed')], { ...who, scope: [] }).bits, 0)
    assert.equal(evaluate([root, input('/allowed-other')], who).bits, 0)
  })

  it('hides an unparseable ACL and its descendants from every actor', () => {
    const corrupt: unknown[] = [null, {}, [{ g: 'readers', p: 7 }], [grant('readers', R), { subject: { group: 'readers' }, grant: 8 }],
      [{ subject: { group: 'readers', owner: true }, grant: R }], [{ subject: { group: 'readers' }, grant: R, deny: W }]]
    for (const $acl of corrupt) {
      const result = evaluate([input('/', { $acl: [grant('readers', ALL)] }), input('/p', { $acl }),
        input('/p/a', { $acl: [grant('readers', ALL)] })])
      assert.equal(result.bits, 0)
      assert.equal(result.prefix.aboveA, false)
      assert.equal(result.alerts[0].path, '/p')
      assert.equal(result.alerts[0].field, '$acl')
    }
  })

  it('hides an unparseable owner and its descendants', () => {
    for (const $owner of [null, '', 'alice', 'u:', {}]) {
      const result = evaluate([input('/', { $acl: [grant('readers', ALL)] }), input('/p', { $owner }), input('/p/a')])
      assert.equal(result.bits, 0)
      assert.equal(result.alerts[0].field, '$owner')
    }
  })

  it('hides an unknown or malformed component only at its own node', () => {
    for (const component of [{ $type: 'missing' }, null, { title: 'missing type' }]) {
      const nodes = [input('/', { $acl: [grant('readers', ALL)] }), input('/p', { '#broken': component }), input('/p/a')]
      assert.equal(evaluate(nodes.slice(0, 2)).bits, 0)
      const result = evaluate(nodes)
      assert.equal(result.bits, ALL)
      assert.equal(result.alerts.length, 1)
      assert.equal(result.alerts[0].path, '/p')
    }
  })

  it('continues every tested ACL fold from any emitted prefix', () => {
    const who = actor(['readers'])
    const types = registry({ 'test.limited': () => R | A })
    for (let grantBits = 0; grantBits <= ALL; grantBits++) for (let denyBits = 0; denyBits <= ALL; denyBits++) for (let later = 0; later <= ALL; later++) {
      const nodes = [input('/', { $owner: 'u:alice', $acl: [grant('readers', grantBits)] }),
        input('/p', { $acl: [deny('readers', denyBits)] }, 'test.limited'),
        input('/p/a', { $owner: 'u:bob', $acl: [grant('readers', later)] }), input('/p/a/x')].map(decodeChainNode)
      const full = computeRights(who, nodes, types)
      for (let cut = 1; cut < nodes.length; cut++) {
        const prefix = computeRights(who, nodes.slice(0, cut), types).prefix
        const continued = computeRights(who, nodes.slice(cut), types, prefix)
        assert.equal(continued.bits, full.bits)
        assert.deepEqual(continued.prefix, full.prefix)
      }
    }
  })

  it('keeps an uncomputable chain hidden across a shard prefix', () => {
    const who = actor(['readers']), types = registry()
    const before = [input('/', { $acl: [grant('readers', ALL)] }), input('/p', { $acl: null })].map(decodeChainNode)
    const first = computeRights(who, before, types)
    const continued = computeRights(who, [decodeChainNode(input('/p/a', { $acl: [grant('readers', ALL)] }))], types, first.prefix)
    assert.equal(first.bits, 0)
    assert.equal(continued.bits, 0)
    assert.equal(continued.prefix.admin, true)
  })
})

describe('rights chain index', () => {
  it('returns existing ancestors in root-to-leaf order across absent parents', () => {
    const index = createChainIndex()
    index.put(input('/p/a'))
    index.put(input('/'))
    assert.deepEqual(index.chain('/p/a').map(node => node.path), ['/', '/p/a'])
    assert.equal(index.get('/p'), undefined)
  })

  it('indexes ACL and owner boundaries with segment-aware subtree matching', () => {
    const index = createChainIndex()
    index.put(input('/p/b', { $owner: 'u:alice' }))
    index.put(input('/p/a', { $acl: [] }))
    index.put(input('/p/plain'))
    index.put(input('/prefix', { $acl: [grant('readers', R)] }))
    assert.deepEqual([...index.boundaries('/p')].map(node => node.path).sort(), ['/p/a', '/p/b'])
  })

  it('keeps descendant boundaries when a parent boundary is cleared or removed', () => {
    const index = createChainIndex()
    index.put(input('/p', { $acl: [grant('readers', R)] }))
    index.put(input('/p/a', { $owner: 'u:alice' }))
    index.put(input('/p/plain'))
    index.put(input('/p'))
    assert.deepEqual([...index.boundaries('/p')].map(node => node.path), ['/p/a'])
    index.remove('/p')
    assert.deepEqual([...index.boundaries('/p')].map(node => node.path), ['/p/a'])
    index.remove('/p/a')
    assert.deepEqual([...index.boundaries('/')], [])
  })

  it('updates grants by subject on replacement and deletion', () => {
    const index = createChainIndex()
    index.put(input('/a', { $acl: [grant('n:form', R), grant('n:form', W), deny('blocked', R), ownerGrant(W)] }))
    index.put(input('/b', { $acl: [grant('n:form', R)] }))
    assert.deepEqual([...index.grants({ group: 'n:form' })].sort(), ['/a', '/b'])
    assert.deepEqual([...index.grants({ owner: true })], ['/a'])
    assert.deepEqual([...index.grants({ group: 'blocked' })], [])
    index.put(input('/a', { $acl: [grant('n:other', R)] }))
    assert.deepEqual([...index.grants({ group: 'n:form' })], ['/b'])
    assert.deepEqual([...index.grants({ owner: true })], [])
    index.remove('/b')
    assert.deepEqual([...index.grants({ group: 'n:form' })], [])
    assert.deepEqual([...index.grants({ group: 'n:other' })], ['/a'])
  })

  it('owns the decoded metadata instead of aliasing Store data', () => {
    const subject = { group: 'readers' }
    const entries = [{ subject, grant: R }]
    const index = createChainIndex()
    index.put(input('/p', { $acl: entries, '#part': { $type: 'test.part' } }))
    subject.group = 'changed'
    entries[0].grant = W
    assert.deepEqual([...index.grants({ group: 'readers' })], ['/p'])
    assert.deepEqual(index.get('/p')?.acl, [grant('readers', R)])
    assert.deepEqual(index.get('/p')?.types, ['test.node', 'test.part'])
  })
})
