import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chain, refVal, runPathWithRefs, TypedRef } from './chain';

// ── basic ──

test('sync field', async () => {
  assert.equal(await chain({ name: 'Alice' }).name, 'Alice')
})

test('sync method', async () => {
  assert.equal(await chain({ greet: (n: string) => `hello ${n}` }).greet('Bob'), 'hello Bob')
})

test('async field', async () => {
  assert.equal(await chain({ fetch: async () => 42 }).fetch(), 42)
})

test('deep sync chain', async () => {
  const obj = { user: { profile: { name: 'Alice' } } }
  assert.equal(await chain(obj).user.profile.name, 'Alice')
})

test('deep async chain', async () => {
  const obj = {
    user: async (id: string) => ({
      id,
      posts: async () => [{ title: 'Hello' }, { title: 'World' }],
    }),
  }
  const posts = await chain(obj).user('123').posts()
  assert.deepEqual(posts, [{ title: 'Hello' }, { title: 'World' }])
})

test('method chaining returns new chain', async () => {
  const obj = {
    add: (n: number) => ({
      multiply: (m: number) => n * m,
    }),
  }
  assert.equal(await chain(obj).add(3).multiply(4), 12)
})

test('this binding preserved', async () => {
  const obj = { value: 42, get() { return this.value } }
  assert.equal(await chain(obj).get(), 42)
})

test('null in chain throws', async () => {
  await assert.rejects(
    async () => { await chain({ user: null } as any).user.name },
  )
})

test('same chain reusable', async () => {
  let callCount = 0
  const obj = { fetch: async () => { callCount++; return callCount } }
  const c = chain(obj).fetch()
  assert.equal(await c, 1)
  assert.equal(await c, 2)  // no caching — executes again
})

test('async error propagates', async () => {
  const obj = { fail: async () => { throw new Error('boom') } }
  await assert.rejects(async () => { await chain(obj).fail() })
})

// ── demo tracker component types ──

class LivePrices {
  static $type = 'demo.live-prices'
  feederUrl = 'ws://localhost:8090'
  async subscribe({ slugs }: { slugs: string[] }) {
    return slugs.map(s => ({ slug: s, bid: 0.6, ask: 0.65 }))
  }
}

class Scanner {
  static $type = 'demo.scanner'
  intervalMs = 900_000
  livePrices: TypedRef<LivePrices> = refVal(LivePrices, '/demo/live-prices')
  depositTracker: TypedRef<DepositTracker> = refVal(DepositTracker, '/demo/deposits')
}

class DepositTracker {
  static $type = 'demo.deposit-tracker'
  async run() { return { added: 12, ts: Date.now() } }
}

class Profile {
  static $type = 'demo.profile'
  address = ''
  async fetch({ address }: { address: string }) {
    return { address, name: 'whale.eth', totalPnl: 50_000 }
  }
  async trades({ page = 1 } = {}) {
    return { page, items: [{ hash: '0xabc', amount: 1000 }] }
  }
}

// ── refVal ──

test('refVal stores $type and $ref', () => {
  const ref = refVal(LivePrices, '/demo/live-prices')
  assert.equal(ref.$type, 'ref')
  assert.equal(ref.$ref, '/demo/live-prices')
})

test('refVal default path is empty', () => {
  const ref = refVal(LivePrices)
  assert.equal(ref.$ref, '')
})

// ── server executor: auto-resolves refs ──

function makeStore(entries: [string, any][]) {
  const m = new Map(entries)
  return (ref: { $ref: string }) => {
    const node = m.get(ref.$ref)
    if (!node) throw new Error(`Ref not found: ${ref.$ref}`)
    return Promise.resolve(node)
  }
}

test('runPathWithRefs: follows ref to node', async () => {
  const live = new LivePrices()
  const scanner = new Scanner()

  const result = await runPathWithRefs(
    scanner,
    ['livePrices', 'subscribe', [{ slugs: ['btc-win'] }]],
    makeStore([['/demo/live-prices', live]]),
  )

  assert.deepEqual(result, [{ slug: 'btc-win', bid: 0.6, ask: 0.65 }])
})

test('runPathWithRefs: multiple refs in one session', async () => {
  const live = new LivePrices()
  const deposits = new DepositTracker()
  const scanner = new Scanner()
  const resolve = makeStore([
    ['/demo/live-prices', live],
    ['/demo/deposits', deposits],
  ])

  const prices = await runPathWithRefs(scanner, ['livePrices', 'subscribe', [{ slugs: ['x'] }]], resolve)
  const run = await runPathWithRefs(scanner, ['depositTracker', 'run', []], resolve)

  assert.ok(Array.isArray(prices))
  assert.equal(run.added, 12)
})

test('runPathWithRefs: nested refs (ref → node → ref → node)', async () => {
  const profile = new Profile()
  // live node has a nested ref to profile
  const liveNode = { profile: { $type: 'ref', $ref: '/demo/profiles/0xabc' } }
  const scanner = { live: { $type: 'ref', $ref: '/demo/live' } }

  const result = await runPathWithRefs(
    scanner,
    ['live', 'profile', 'fetch', [{ address: '0xabc' }]],
    makeStore([
      ['/demo/live', liveNode],
      ['/demo/profiles/0xabc', profile],
    ]),
  )

  assert.deepEqual(result, { address: '0xabc', name: 'whale.eth', totalPnl: 50_000 })
})

test('runPathWithRefs: missing ref throws', async () => {
  const scanner = new Scanner()
  await assert.rejects(
    () => runPathWithRefs(scanner, ['livePrices', 'subscribe', [{ slugs: [] }]], makeStore([])),
  )
})

test('runPathWithRefs: profile trades pagination', async () => {
  const profile = new Profile()
  const node = { target: { $type: 'ref', $ref: '/profile' } }

  const result = await runPathWithRefs(
    node,
    ['target', 'trades', [{ page: 2 }]],
    makeStore([['/profile', profile]]),
  )

  assert.deepEqual(result, { page: 2, items: [{ hash: '0xabc', amount: 1000 }] })
})
