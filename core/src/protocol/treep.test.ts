// TreeP Protocol — Tests first, implementation follows
// Tests the createTreeP dispatch layer: URI → Tree method routing

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryTree } from '#tree'
import { createTreeP, type TreePError, type ActionExecutor } from '#protocol/treep'

// Helper: create a TreeP instance backed by memory tree with seed data
async function setup() {
  const tree = createMemoryTree()

  // Container nodes (so getChildren('/') finds them)
  await tree.set({ $path: '/orders', $type: 'dir' })
  await tree.set({ $path: '/users', $type: 'dir' })
  await tree.set({ $path: '/tasks', $type: 'dir' })

  // Seed data
  await tree.set({ $path: '/orders/1', $type: 'order', status: 'pending', amount: 100 })
  await tree.set({ $path: '/orders/2', $type: 'order', status: 'done', amount: 200 })
  await tree.set({ $path: '/orders/3', $type: 'order', status: 'pending', amount: 50 })
  await tree.set({ $path: '/users/kriz', $type: 'user', name: 'Kriz', email: 'kriz@test.com' })
  // Node with named component
  await tree.set({ $path: '/tasks/1', $type: 'task', title: 'Fix bug', workflow: { $type: 'workflow', state: 'open' } })

  const tp = createTreeP(tree)
  return { tree, tp }
}

// ── get() dispatch ──

describe('TreeP get() — node', () => {
  it('returns node by path', async () => {
    const { tp } = await setup()
    const node = await tp.get('/orders/1')
    assert.equal(node.$type, 'order')
    assert.equal(node.status, 'pending')
  })

  it('returns undefined for missing node', async () => {
    const { tp } = await setup()
    const node = await tp.get('/nonexistent')
    assert.equal(node, undefined)
  })
})

describe('TreeP get() — children (trailing slash)', () => {
  it('returns children page', async () => {
    const { tp } = await setup()
    const page = await tp.get('/orders/')
    assert.ok(page.items)
    assert.equal(page.items.length, 3)
  })

  it('supports pagination', async () => {
    const { tp } = await setup()
    const page = await tp.get('/orders/', { limit: 2 })
    assert.equal(page.items.length, 2)
  })

  it('root children via opts.children', async () => {
    const { tp } = await setup()
    const page = await tp.get('/', { children: true })
    assert.ok(page.items)
    assert.ok(page.items.length >= 2) // /orders, /users, /tasks
  })
})

describe('TreeP get() — field (#name)', () => {
  it('returns top-level field value', async () => {
    const { tp } = await setup()
    const status = await tp.get('/orders/1#status')
    assert.equal(status, 'pending')
  })

  it('returns undefined for missing field', async () => {
    const { tp } = await setup()
    const val = await tp.get('/orders/1#nonexistent')
    assert.equal(val, undefined)
  })

  it('returns undefined when node missing', async () => {
    const { tp } = await setup()
    const val = await tp.get('/nonexistent#field')
    assert.equal(val, undefined)
  })
})

describe('TreeP get() — nested field (#key.field)', () => {
  it('returns component field', async () => {
    const { tp } = await setup()
    const state = await tp.get('/tasks/1#workflow.state')
    assert.equal(state, 'open')
  })

  it('returns component object (#key without field)', async () => {
    const { tp } = await setup()
    const wf = await tp.get('/tasks/1#workflow')
    assert.equal(wf.$type, 'workflow')
    assert.equal(wf.state, 'open')
  })
})

// ── set() dispatch ──

describe('TreeP set() — replace node', () => {
  it('replaces node when data has $type', async () => {
    const { tp } = await setup()
    await tp.set('/orders/1', { $path: '/orders/1', $type: 'order', status: 'shipped', amount: 100 })
    const node = await tp.get('/orders/1')
    assert.equal(node.status, 'shipped')
  })

  it('URI is authoritative — $path in data is overridden', async () => {
    const { tp } = await setup()
    // data.$path says /users/kriz but URI says /orders/1 — URI wins
    await tp.set('/orders/1', { $path: '/users/kriz', $type: 'order', status: 'hijacked', amount: 999 })
    const node = await tp.get('/orders/1')
    assert.equal(node.status, 'hijacked')
    // /users/kriz should be untouched
    const kriz = await tp.get('/users/kriz')
    assert.equal(kriz.name, 'Kriz')
  })
})

describe('TreeP set() — patch ops', () => {
  it('applies patch when data is array', async () => {
    const { tp } = await setup()
    await tp.set('/orders/1', [['r', 'status', 'shipped']])
    const node = await tp.get('/orders/1')
    assert.equal(node.status, 'shipped')
  })

  it('rejects invalid patch ops', async () => {
    const { tp } = await setup()
    await assert.rejects(
      () => tp.set('/orders/1', [['x', 'status', 'bad']]),
      (err: TreePError) => err.status === 400
    )
  })

  it('rejects malformed patch entries', async () => {
    const { tp } = await setup()
    await assert.rejects(
      () => tp.set('/orders/1', [[42]]),
      (err: TreePError) => err.status === 400
    )
  })
})

describe('TreeP set() — field (#name)', () => {
  it('sets top-level field', async () => {
    const { tp } = await setup()
    await tp.set('/orders/1#status', 'cancelled')
    const node = await tp.get('/orders/1')
    assert.equal(node.status, 'cancelled')
  })
})

describe('TreeP set() — nested field (#key.field)', () => {
  it('sets component field', async () => {
    const { tp } = await setup()
    await tp.set('/tasks/1#workflow.state', 'closed')
    const state = await tp.get('/tasks/1#workflow.state')
    assert.equal(state, 'closed')
  })
})

// ── remove() ──

describe('TreeP remove()', () => {
  it('removes existing node (idempotent void)', async () => {
    const { tp } = await setup()
    await tp.remove('/orders/1')
    const node = await tp.get('/orders/1')
    assert.equal(node, undefined)
  })

  it('removing nonexistent node does not throw', async () => {
    const { tp } = await setup()
    await tp.remove('/nonexistent') // should not throw
  })
})

// ── URI dispatch edge cases ──

describe('TreeP URI dispatch', () => {
  it('trailing slash on non-root path = children', async () => {
    const { tp } = await setup()
    const page = await tp.get('/users/')
    assert.ok(page.items)
    assert.equal(page.items.length, 1)
  })

  it('set on children URI is rejected', async () => {
    const { tp } = await setup()
    await assert.rejects(
      () => tp.set('/orders/', { $type: 'order' }),
      (err: TreePError) => err.status === 400
    )
  })

  it('remove on non-path URI is rejected', async () => {
    const { tp } = await setup()
    await assert.rejects(
      () => tp.remove('/orders/1#field'),
      (err: TreePError) => err.status === 400
    )
  })

  it('get on action URI is rejected', async () => {
    const { tp } = await setup()
    await assert.rejects(
      () => tp.get('/orders/1#ship()'),
      (err: TreePError) => err.status === 400
    )
  })

  it('set with invalid data shape is rejected', async () => {
    const { tp } = await setup()
    await assert.rejects(
      () => tp.set('/orders/1', 'just a string'),
      (err: TreePError) => err.status === 400
    )
  })

  it('malformed URI throws TreePError, not raw Error', async () => {
    const { tp } = await setup()
    await assert.rejects(
      () => tp.get('/orders/1#key.'),
      (err: TreePError) => err.status === 400
    )
  })
})

// ── Action dispatch via set() ──

describe('TreeP set() — action dispatch', () => {
  it('routes action URI to executor', async () => {
    const tree = createMemoryTree()
    await tree.set({ $path: '/orders/1', $type: 'order', status: 'pending' })

    let called: { path: string; key: string | undefined; action: string; data: unknown } | null = null
    const executor: ActionExecutor = async (path, key, action, data) => {
      called = { path, key, action, data }
      return { ok: true }
    }

    const tp = createTreeP(tree, executor)
    const result = await tp.set('/orders/1#ship()', { urgent: true })

    assert.deepEqual(called, { path: '/orders/1', key: undefined, action: 'ship', data: { urgent: true } })
    assert.deepEqual(result, { ok: true })
  })

  it('passes key for component action URI', async () => {
    const tree = createMemoryTree()
    await tree.set({ $path: '/tasks/1', $type: 'task' })

    let called: { path: string; key: string | undefined; action: string } | null = null
    const executor: ActionExecutor = async (path, key, action) => {
      called = { path, key, action }
    }

    const tp = createTreeP(tree, executor)
    await tp.set('/tasks/1#workflow.advance()', { step: 2 })

    assert.equal(called!.path, '/tasks/1')
    assert.equal(called!.key, 'workflow')
    assert.equal(called!.action, 'advance')
  })

  it('throws 400 when no executor configured', async () => {
    const tree = createMemoryTree()
    const tp = createTreeP(tree) // no executor
    await assert.rejects(
      () => tp.set('/orders/1#ship()'),
      (err: TreePError) => err.status === 400
    )
  })
})

// ── TreePError ──

describe('TreePError shape', () => {
  it('has type, status, title fields', async () => {
    const { tp } = await setup()
    try {
      await tp.set('/orders/', { $type: 'order' })
      assert.fail('should throw')
    } catch (err) {
      const e = err as TreePError
      assert.equal(typeof e.type, 'string')
      assert.equal(typeof e.status, 'number')
      assert.equal(typeof e.title, 'string')
      assert.ok(e.type.startsWith('tree:'))
    }
  })
})
