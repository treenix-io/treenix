import { refVal, type TypedRef } from '#chain';
import { registerType } from '#comp';
import { isRef } from '#core';
import type { Tree } from '#tree';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { treeChain } from './tree-chain';

// ── Test types ──

class Scanner {
  static $type = 'tch.scanner'
  intervalMs = 900_000
  maxRetries = 3
  livePrices: TypedRef<LivePrices> = refVal(LivePrices)
  scan() { return { started: true } }
  configure(data: { interval: number }) { return data }
}
registerType('tch.scanner', Scanner)

class LivePrices {
  static $type = 'tch.live-prices'
  feederUrl = 'ws://localhost:8090'
  subscribe(data: { slugs: string[] }) {
    return data.slugs.map((s: string) => ({ slug: s, bid: 0.6 }))
  }
}
registerType('tch.live-prices', LivePrices)

class Profile {
  static $type = 'tch.profile'
  name = ''
  balance = 0
}
registerType('tch.profile', Profile)

class Wallet {
  static $type = 'tch.wallet'
  address = ''
  chain = ''
}
registerType('tch.wallet', Wallet)

// ── Seed ──

async function seed(): Promise<Tree> {
  const tree = createMemoryTree()

  await tree.set({ $path: '/services', $type: 'dir' })
  await tree.set({
    $path: '/services/scanner',
    $type: 'tch.scanner',
    intervalMs: 900_000,
    maxRetries: 3,
    livePrices: { $type: 'ref', $ref: '/services/live-prices' },
  })
  await tree.set({
    $path: '/services/live-prices',
    $type: 'tch.live-prices',
    feederUrl: 'ws://localhost:8090',
  })

  // Children of scanner
  await tree.set({ $path: '/services/scanner/s1', $type: 'tch.scan-result', ts: 1000 })
  await tree.set({ $path: '/services/scanner/s2', $type: 'tch.scan-result', ts: 2000 })

  // Node with named component
  await tree.set({
    $path: '/users/alice',
    $type: 'tch.profile',
    name: 'Alice',
    balance: 100,
    wallet: { $type: 'tch.wallet', address: '0xabc', chain: 'eth' },
  })

  return tree
}

describe('treeChain — path building', () => {
  test('$path from dot navigation', () => {
    const c = treeChain(null as any)
    assert.equal(c.services.scanner.$path, '/services/scanner')
  })

  test('$path from root', () => {
    const c = treeChain(null as any)
    assert.equal(c.$path, '/')
  })

  test('$path with basePath', () => {
    const c = treeChain(null as any, '/services')
    assert.equal(c.scanner.$path, '/services/scanner')
  })

  test('$path with bracket access', () => {
    const c = treeChain(null as any)
    assert.equal(c.services.scanner['s1'].$path, '/services/scanner/s1')
  })
})

describe('treeChain — node materialization (await)', () => {
  test('await returns node data', async () => {
    const tree = await seed()
    const c = treeChain(tree)
    const node = await c.services.scanner
    assert.equal(node.$type, 'tch.scanner')
    assert.equal(node.intervalMs, 900_000)
  })

  test('await deep path', async () => {
    const tree = await seed()
    const node = await treeChain(tree).services.scanner['s1']
    assert.equal(node.ts, 1000)
  })

  test('await missing node throws', async () => {
    const tree = await seed()
    await assert.rejects(async () => { await treeChain(tree).nothing.here })
  })
})

describe('treeChain — $get (typed component)', () => {
  test('$get returns typed fields', async () => {
    const tree = await seed()
    const scanner: Scanner = await treeChain(tree).services.scanner.$get(Scanner)
    assert.equal(scanner.intervalMs, 900_000)
    assert.equal(scanner.maxRetries, 3)
  })

  test('$field with named component', async () => {
    const tree = await seed()
    const wallet = await treeChain(tree).users.alice.$field('wallet')
    assert.equal(wallet.address, '0xabc')
  })

  test('$get wrong type throws', async () => {
    const tree = await seed()
    await assert.rejects(async () => { await treeChain(tree).services.scanner.$get(LivePrices) })
  })
})

describe('treeChain — (Class) bracket access', () => {
  test('(Class) returns typed fields', async () => {
    const tree = await seed()
    const scanner: Scanner = await treeChain(tree).services.scanner(Scanner)
    assert.equal(scanner.intervalMs, 900_000)
    assert.equal(scanner.maxRetries, 3)
  })

  test('(Class) finds named component by type scan', async () => {
    const tree = await seed()
    const wallet = await treeChain(tree).users.alice(Wallet)
    assert.equal(wallet.address, '0xabc')
  })

  test('(Class) wrong type throws', async () => {
    const tree = await seed()
    await assert.rejects(async () => { await treeChain(tree).services.scanner(LivePrices) })
  })

  test('(Class) then ref follow', async () => {
    const tree = await seed()
    const lp = await treeChain(tree).services.scanner(Scanner).livePrices
    assert.equal(lp.feederUrl, 'ws://localhost:8090')
  })

  test('(Class) → ref → action', async () => {
    const tree = await seed()
    const result = await treeChain(tree)
      .services.scanner(Scanner).livePrices
      .subscribe({ slugs: ['btc'] })
    assert.deepEqual(result, [{ slug: 'btc', bid: 0.6 }])
  })
})

describe('treeChain — ref auto-follow', () => {
  test('TypedRef field resolves to target node', async () => {
    const tree = await seed()
    // scanner.livePrices is { $ref: '/services/live-prices' }
    // chain follows ref automatically
    const lp = await treeChain(tree).services.scanner.$get(Scanner).livePrices
    assert.equal(lp.feederUrl, 'ws://localhost:8090')
  })

  test('ref field then field access', async () => {
    const tree = await seed()
    const url = await treeChain(tree).services.scanner.$get(Scanner).livePrices.feederUrl
    assert.equal(url, 'ws://localhost:8090')
  })

  test('missing ref throws', async () => {
    const tree = await seed()
    // Set scanner with broken ref
    await tree.set({
      $path: '/broken',
      $type: 'tch.scanner',
      livePrices: { $type: 'ref', $ref: '/nonexistent' },
    })
    await assert.rejects(async () => { await treeChain(tree).broken.$get(Scanner).livePrices })
  })
})

describe('treeChain — actions', () => {
  test('action call returns result', async () => {
    const tree = await seed()
    const result = await treeChain(tree).services.scanner(Scanner).scan()
    assert.deepEqual(result, { started: true })
  })

  test('action with data', async () => {
    const tree = await seed()
    const result = await treeChain(tree).services.scanner(Scanner).configure({ interval: 5000 })
    assert.deepEqual(result, { interval: 5000 })
  })

  test('action on ref target', async () => {
    const tree = await seed()
    const result = await treeChain(tree)
      .services.scanner
      .$get(Scanner).livePrices
      .subscribe({ slugs: ['btc'] })
    assert.deepEqual(result, [{ slug: 'btc', bid: 0.6 }])
  })
})

describe('treeChain — $children', () => {
  test('returns child nodes', async () => {
    const tree = await seed()
    const kids = await treeChain(tree).services.scanner.$children()
    assert.equal(kids.length, 2)
  })

  test('with query filter', async () => {
    const tree = await seed()
    const kids = await treeChain(tree).services.scanner.$children({ ts: 1000 })
    assert.equal(kids.length, 1)
    assert.equal(kids[0].ts, 1000)
  })

  test('empty children', async () => {
    const tree = await seed()
    const kids = await treeChain(tree).services['live-prices'].$children()
    assert.equal(kids.length, 0)
  })
})

describe('treeChain — composition', () => {
  test('chain is reusable (no state mutation)', async () => {
    const tree = await seed()
    const services = treeChain(tree).services
    const a = await services.scanner
    const b = await services['live-prices']
    assert.equal(a.$type, 'tch.scanner')
    assert.equal(b.$type, 'tch.live-prices')
  })

  test('chain from basePath', async () => {
    const tree = await seed()
    const scanner = await treeChain(tree, '/services/scanner')
    assert.equal(scanner.$type, 'tch.scanner')
  })

  test('full pipeline: navigate → type → ref → action', async () => {
    const tree = await seed()
    const result = await treeChain(tree)
      .services       // → /services (child nav)
      .scanner        // → /services/scanner (child nav)
      .$get(Scanner)  // → typed as Scanner
      .livePrices     // → follow ref → /services/live-prices
      .subscribe({ slugs: ['eth', 'btc'] })  // → action on LivePrices

    assert.equal(result.length, 2)
    assert.equal(result[0].slug, 'eth')
    assert.equal(result[1].slug, 'btc')
  })
})

// ── Real-world usage examples ──
// These show how treeChain would be used on a real Treenix tree.
// Seed mimics actual /board, /cafe, /agent structure.

class BoardTask {
  static $type = 'tch.board.task'
  title = ''
  status = 'backlog'
  priority = 'normal'
  move(data: { status: string }) { return { moved: data.status } }
  assign(data: { to: string }) { return { assigned: data.to } }
}
registerType('tch.board.task', BoardTask)

class BoardKanban {
  static $type = 'tch.board.kanban'
}
registerType('tch.board.kanban', BoardKanban)

class CafeContact {
  static $type = 'tch.cafe.contact'
  phone = ''
  address = ''
}
registerType('tch.cafe.contact', CafeContact)

class AgentConfig {
  static $type = 'tch.agent.config'
  model = ''
  bot: TypedRef<BrahmanBot> = refVal(BrahmanBot)
}
registerType('tch.agent.config', AgentConfig)

class BrahmanBot {
  static $type = 'tch.brahman.bot'
  alias = ''
  running = false
  restart() { return { restarted: true } }
}
registerType('tch.brahman.bot', BrahmanBot)

async function seedRealWorld(): Promise<Tree> {
  const tree = createMemoryTree()

  // /board — kanban with task children
  await tree.set({ $path: '/board', $type: 'tch.board.kanban' })
  await tree.set({
    $path: '/board/landing',
    $type: 'tch.board.task',
    title: 'Landing treenix.land',
    status: 'doing',
    priority: 'urgent',
  })
  await tree.set({
    $path: '/board/npm-split',
    $type: 'tch.board.task',
    title: 'npm monorepo split',
    status: 'done',
    priority: 'high',
  })
  await tree.set({
    $path: '/board/agent-toolkit',
    $type: 'tch.board.task',
    title: 'Agent Toolkit — MCP tools',
    status: 'backlog',
    priority: 'urgent',
  })

  // /cafe — contact with nested component
  await tree.set({
    $path: '/cafe/contact',
    $type: 'tch.cafe.contact',
    phone: '+7-999-123-4567',
    address: 'Moscow, Tverskaya 1',
  })

  // /agent — config with ref to bot
  await tree.set({
    $path: '/agent',
    $type: 'tch.agent.config',
    model: 'claude-opus-4-6',
    bot: { $type: 'ref', $ref: '/brahman' },
  })
  await tree.set({
    $path: '/brahman',
    $type: 'tch.brahman.bot',
    alias: '@treenixbot',
    running: true,
  })

  return tree
}

describe('real-world: board tasks', () => {
  test('read task title by path', async () => {
    const tree = await seedRealWorld()
    const task = await treeChain(tree).board.landing
    assert.equal(task.title, 'Landing treenix.land')
    assert.equal(task.status, 'doing')
  })

  test('list all board tasks', async () => {
    const tree = await seedRealWorld()
    const tasks = await treeChain(tree).board.$children()
    assert.equal(tasks.length, 3)
  })

  test('filter tasks by status', async () => {
    const tree = await seedRealWorld()
    const doing = await treeChain(tree).board.$children({ status: 'doing' })
    assert.equal(doing.length, 1)
    assert.equal(doing[0].title, 'Landing treenix.land')
  })

  test('move task via action', async () => {
    const tree = await seedRealWorld()
    const result = await treeChain(tree).board.landing(BoardTask).move({ status: 'review' })
    assert.deepEqual(result, { moved: 'review' })
  })

  test('assign task', async () => {
    const tree = await seedRealWorld()
    const result = await treeChain(tree).board['agent-toolkit'](BoardTask).assign({ to: 'agent' })
    assert.deepEqual(result, { assigned: 'agent' })
  })

  test('save chain as bookmark, reuse', async () => {
    const tree = await seedRealWorld()
    const board = treeChain(tree).board

    const t1 = await board.landing
    const t2 = await board['npm-split']
    assert.equal(t1.priority, 'urgent')
    assert.equal(t2.status, 'done')
  })
})

describe('real-world: cross-node refs', () => {
  test('agent → bot ref auto-follow', async () => {
    const tree = await seedRealWorld()
    const bot = await treeChain(tree).agent.$get(AgentConfig).bot
    assert.equal(bot.alias, '@treenixbot')
    assert.equal(bot.running, true)
  })

  test('action through ref: restart bot via agent', async () => {
    const tree = await seedRealWorld()
    const result = await treeChain(tree)
      .agent
      .$get(AgentConfig).bot
      .restart()
    assert.deepEqual(result, { restarted: true })
  })

  test('read field through ref', async () => {
    const tree = await seedRealWorld()
    const alias = await treeChain(tree).agent.$get(AgentConfig).bot.alias
    assert.equal(alias, '@treenixbot')
  })
})

describe('real-world: (Class) bracket access', () => {
  test('agent(AgentConfig).bot auto-follows ref', async () => {
    const tree = await seedRealWorld()
    const bot = await treeChain(tree).agent(AgentConfig).bot
    assert.equal(bot.alias, '@treenixbot')
    assert.equal(bot.running, true)
  })

  test('(Class) → ref → action', async () => {
    const tree = await seedRealWorld()
    const result = await treeChain(tree).agent(AgentConfig).bot.restart()
    assert.deepEqual(result, { restarted: true })
  })

  test('(Class) → ref → field', async () => {
    const tree = await seedRealWorld()
    const alias = await treeChain(tree).agent(AgentConfig).bot.alias
    assert.equal(alias, '@treenixbot')
  })
})

describe('real-world: ergonomics comparison', () => {
  // These tests show the same operation done via treeChain vs old API
  // to demonstrate the ergonomics gain.

  test('old way vs new way: read nested data', async () => {
    const tree = await seedRealWorld()

    // OLD: 3 lines, manual path construction, no types
    const node = await tree.get('/board/landing')
    assert.ok(node)
    const title = node.title

    // NEW: 1 expression, dot navigation
    const title2 = (await treeChain(tree).board.landing).title

    assert.equal(title, title2)
  })

  test('old way vs new way: follow ref + action', async () => {
    const tree = await seedRealWorld()

    // OLD: manual ref resolution, 4+ lines
    const agentNode = await tree.get('/agent')
    assert.ok(agentNode)
    const botRef = (agentNode as any).bot
    assert.ok(isRef(botRef))
    // would need: const bot = await tree.get(botRef.$ref)
    // then: executeAction(tree, botRef.$ref, ..., 'restart')

    // NEW: one chain — navigate, follow ref, call action
    const result = await treeChain(tree).agent.$get(AgentConfig).bot.restart()
    assert.deepEqual(result, { restarted: true })
  })
})

describe('treeChain — $set', () => {
  test('creates node with type from class', async () => {
    const tree = createMemoryTree()
    await treeChain(tree).status.$set(LivePrices, { feederUrl: 'ws://example.com' })
    const node = await tree.get('/status')
    assert.ok(node)
    assert.equal(node.$type, 'tch.live-prices')
    assert.equal(node.feederUrl, 'ws://example.com')
  })

  test('overwrites existing node', async () => {
    const tree = await seed()
    await treeChain(tree).services.scanner.$set(Scanner, { intervalMs: 5000, maxRetries: 1 })
    const node = await tree.get('/services/scanner')
    assert.equal(node!.intervalMs, 5000)
    assert.equal(node!.maxRetries, 1)
  })

  test('deep path via dot navigation', async () => {
    const tree = createMemoryTree()
    await treeChain(tree).a.b.c.$set(Profile, { name: 'Deep', balance: 42 })
    const node = await tree.get('/a/b/c')
    assert.ok(node)
    assert.equal(node.$type, 'tch.profile')
    assert.equal(node.name, 'Deep')
    assert.equal(node.balance, 42)
  })

  test('no data — creates node with just type', async () => {
    const tree = createMemoryTree()
    await treeChain(tree).board.$set(BoardKanban)
    const node = await tree.get('/board')
    assert.ok(node)
    assert.equal(node.$type, 'tch.board.kanban')
  })

  test('$set then read back via chain', async () => {
    const tree = createMemoryTree()
    const t = treeChain(tree)
    await t.users.bob.$set(Profile, { name: 'Bob', balance: 250 })
    const bob = await t.users.bob
    assert.equal(bob.name, 'Bob')
    assert.equal(bob.balance, 250)
  })

  test('$set with ref field', async () => {
    const tree = createMemoryTree()
    await treeChain(tree).brahman.$set(BrahmanBot, { alias: '@bot', running: true })
    await treeChain(tree).agent.$set(AgentConfig, {
      model: 'opus',
      bot: { $type: 'ref', $ref: '/brahman' },
    })
    const bot = await treeChain(tree).agent(AgentConfig).bot
    assert.equal(bot.alias, '@bot')
  })
})

describe('treeChain — Symbol traps', () => {
  test('Symbol.toPrimitive on root', () => {
    assert.equal((treeChain(null as any) as any)[Symbol.toPrimitive], 'TreeChain(/)')
  })

  test('Symbol.toStringTag', () => {
    const c = treeChain(null as any) as any
    assert.equal(c.foo[Symbol.toStringTag], 'TreeChain(/foo)')
  })

  test('other symbols return undefined', () => {
    const c = treeChain(null as any) as any
    assert.equal(c[Symbol.iterator], undefined)
    assert.equal(c[Symbol.asyncIterator], undefined)
  })
})

describe('treeChain — basePath edge cases', () => {
  test('basePath without leading slash', () => {
    const c = treeChain(null as any, 'services/scanner')
    assert.equal(c.$path, '/services/scanner')
  })

  test('basePath await resolves directly', async () => {
    const tree = await seed()
    const node = await treeChain(tree, '/services/scanner')
    assert.equal(node.$type, 'tch.scanner')
    assert.equal(node.intervalMs, 900_000)
  })

  test('basePath + child nav', async () => {
    const tree = await seed()
    const node = await treeChain(tree, '/services').scanner
    assert.equal(node.$type, 'tch.scanner')
  })
})

describe('treeChain — error paths', () => {
  test('action without (Class) throws', async () => {
    const tree = await seed()
    const t = treeChain(tree) as any
    await assert.rejects(
      async () => { await t.services.scanner.scan() },
      (e: Error) => e.message.includes('Class'),
    )
  })

  test('unregistered action throws', async () => {
    const tree = await seed()
    const t = treeChain(tree) as any
    await assert.rejects(
      async () => { await t.services.scanner(Scanner).nonexistent() },
      (e: Error) => e.message.includes('action'),
    )
  })

  test('null field in ops throws', async () => {
    const tree = await seed()
    const t = treeChain(tree) as any
    await assert.rejects(
      async () => { await t.services.scanner.$get(Scanner).noSuchField },
      (e: Error) => e.message.includes('null'),
    )
  })

  test('$field with missing named component throws', async () => {
    const tree = await seed()
    await assert.rejects(
      async () => { await treeChain(tree).services.scanner.$field('ghost') },
      (e: Error) => e.message.includes('ghost'),
    )
  })

  test('await root of empty tree throws', async () => {
    const tree = createMemoryTree()
    await assert.rejects(async () => { await treeChain(tree) })
  })
})

describe('treeChain — (Class) where node.$type matches', () => {
  test('getComponent returns node itself when $type matches', async () => {
    const tree = await seed()
    // scanner.$type === 'tch.scanner', Scanner.$type === 'tch.scanner'
    // getComponent returns node itself — all fields at node level
    const node = await treeChain(tree).services.scanner
    assert.equal(node.$type, 'tch.scanner')
    assert.equal(node.$path, '/services/scanner')
    const scanner = await treeChain(tree).services.scanner(Scanner)
    assert.equal(scanner.intervalMs, 900_000)
  })
})

describe('treeChain — ref edge cases', () => {
  test('ref without $type field is still followed', async () => {
    const tree = createMemoryTree()
    await tree.set({
      $path: '/target',
      $type: 'tch.live-prices',
      feederUrl: 'ws://bare-ref',
    })
    await tree.set({
      $path: '/source',
      $type: 'tch.scanner',
      intervalMs: 1,
      maxRetries: 1,
      // ref without $type — isRef accepts { $ref: string }
      livePrices: { $ref: '/target' },
    })
    const lp = await treeChain(tree).source.$get(Scanner).livePrices
    assert.equal(lp.feederUrl, 'ws://bare-ref')
  })

  test('ref field → then read field on resolved target', async () => {
    const tree = await seed()
    const url = await treeChain(tree).services.scanner(Scanner).livePrices.feederUrl
    assert.equal(url, 'ws://localhost:8090')
  })
})

describe('treeChain — multiple ops chain', () => {
  test('field → field reads chain correctly', async () => {
    const tree = createMemoryTree()
    await tree.set({
      $path: '/config',
      $type: 'tch.scanner',
      intervalMs: 1,
      maxRetries: 1,
      livePrices: { $type: 'ref', $ref: '/lp' },
      nested: { $type: 'tch.wallet', address: '0x123', chain: 'polygon' },
    })
    await tree.set({ $path: '/lp', $type: 'tch.live-prices', feederUrl: 'ws://chain' })

    // $get → field (nested component, not a ref) → field
    const chain = await treeChain(tree).config.$field('nested').chain
    assert.equal(chain, 'polygon')
  })
})

describe('treeChain — chain isolation', () => {
  test('two chains from same root are independent', async () => {
    const tree = await seed()
    const t = treeChain(tree)

    const chain1 = t.services.scanner
    const chain2 = t.services['live-prices']

    const s = await chain1
    const lp = await chain2
    assert.equal(s.$type, 'tch.scanner')
    assert.equal(lp.$type, 'tch.live-prices')
  })

  test('(Class) on one branch does not affect another', async () => {
    const tree = await seed()
    const services = treeChain(tree).services

    const typed = await services.scanner(Scanner)
    const raw = await services.scanner

    assert.equal(typed.intervalMs, 900_000)
    assert.equal(raw.intervalMs, 900_000)
    assert.equal(raw.$type, 'tch.scanner')
  })
})
