// E2E test for the treerun (create-treenity) experience.
// Tests: factory boot → seed → tRPC → persistence across restart
// Covers both: default ACL (authenticated only) and public ACL via custom rootNode.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createNode, R, S, W } from '#core'
import type { Tree } from '#tree'
import { createClient } from './client'
import { treenity } from './factory'

// -- Seeds --

async function minimalSeed(_tree: Tree) {}

async function agentRuntimeSeed(tree: Tree) {
  if (await tree.get('/agents')) return

  await tree.set({ $path: '/agents', $type: 'ai.pool', maxConcurrent: 2, active: [], queue: [] })
  await tree.set({
    $path: '/agents/guardian', $type: 'dir',
    policy: {
      $type: 'ai.policy',
      allow: ['mcp__treenity__get_node', 'mcp__treenity__list_children'],
      deny: ['mcp__treenity__remove_node'],
      escalate: ['mcp__treenity__set_node'],
    },
  })
  await tree.set({ $path: '/agents/approvals', $type: 'ai.approvals' })
  await tree.set({
    $path: '/agents/qa', $type: 'ai.agent',
    role: 'qa', status: 'idle', currentTask: '', taskRef: '',
    lastRunAt: 0, totalTokens: 0,
  })
  await tree.set({ $path: '/agents/qa/tasks', $type: 'dir' })
  await tree.set({
    $path: '/agents/dev', $type: 'ai.agent',
    role: 'dev', status: 'idle', currentTask: '', taskRef: '',
    lastRunAt: 0, totalTokens: 0,
  })
  await tree.set({ $path: '/agents/dev/tasks', $type: 'dir' })
  await tree.set({ $path: '/board', $type: 'board.kanban' })
  await tree.set({ $path: '/board/backlog', $type: 'board.column', title: 'Backlog', order: 0 })
  await tree.set({ $path: '/board/data', $type: 'dir' })
  await tree.set({
    $path: '/board/data/hello-world', $type: 'board.task',
    title: 'Hello World', status: 'todo', priority: 'normal', createdAt: Date.now(),
  })
}

// -- Infra --

type Ctx = {
  app: Awaited<ReturnType<typeof treenity>>
  server: Server
  url: string
  tmpDir: string
  sockets: Set<Socket>
}

function publicRootNode(dataDir: string) {
  const node = createNode('/', 'root', {}, {
    mount: { $type: 't.mount.overlay', layers: ['base', 'work'] },
    base: { $type: 't.mount.fs', root: dataDir + '/base' },
    work: { $type: 't.mount.fs', root: dataDir + '/work' },
  })
  node.$acl = [
    { g: 'public', p: R | W | S },
    { g: 'authenticated', p: R | W | S },
    { g: 'admins', p: R | W | S },
  ]
  return node
}

async function boot(
  seed: (tree: Tree) => Promise<void>,
  tmpDir?: string,
  opts?: { publicAccess?: boolean },
): Promise<Ctx> {
  const dir = tmpDir ?? mkdtempSync(join(tmpdir(), 'treerun-e2e-'))
  const rootNode = opts?.publicAccess ? publicRootNode(dir) : undefined
  const app = await treenity({ dataDir: dir, modsDir: false, seed, autostart: false, rootNode })
  const server = await app.listen(0, { allowedOrigins: ['*'] })
  const sockets = new Set<Socket>()
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const port = (server.address() as { port: number }).port
  return { app, server, url: `http://127.0.0.1:${port}/`, tmpDir: dir, sockets }
}

async function shutdown(ctx: Ctx) {
  for (const s of ctx.sockets) s.destroy()
  ctx.sockets.clear()
  await ctx.app.stop()
  await new Promise<void>(r => ctx.server.close(() => r()))
}

async function authedClient(url: string, userId = 'e2e-user', password = 'e2e-pass') {
  const anon = createClient(url)
  await anon.register.mutate({ userId, password }).catch(() => {})
  const { token } = await anon.login.mutate({ userId, password })
  return createClient(url, token)
}

// -- Default ACL: anonymous access denied --

describe('e2e: treerun default ACL', () => {
  let ctx: Ctx

  before(async () => { ctx = await boot(minimalSeed) })
  after(async () => {
    await shutdown(ctx)
    rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('anon get returns undefined (access denied)', async () => {
    const c = createClient(ctx.url)
    const root = await c.get.query({ path: '/' })
    assert.equal(root, undefined)
  })

  it('anon set rejected', async () => {
    const c = createClient(ctx.url)
    await assert.rejects(
      () => c.set.mutate({ node: { $path: '/hack', $type: 'doc' } }),
      (e: unknown) => (e as { data?: { code?: string } }).data?.code === 'FORBIDDEN',
    )
  })

  it('authenticated user can read root', async () => {
    const c = await authedClient(ctx.url)
    const root = await c.get.query({ path: '/' })
    assert.ok(root)
    assert.equal(root.$type, 't.root')
  })
})

// -- Public ACL: minimal template --

describe('e2e: treerun minimal (public)', () => {
  let ctx: Ctx

  before(async () => { ctx = await boot(minimalSeed, undefined, { publicAccess: true }) })
  after(async () => {
    await shutdown(ctx)
    rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('root node exists', async () => {
    const c = createClient(ctx.url)
    const root = await c.get.query({ path: '/' })
    assert.ok(root)
    assert.equal(root.$type, 't.root')
  })

  it('CRUD set → get → remove', async () => {
    const c = createClient(ctx.url)
    await c.set.mutate({ node: { $path: '/test', $type: 'doc', title: 'hello' } })

    const node = await c.get.query({ path: '/test' })
    assert.equal(node?.$type, 'doc')
    assert.equal((node as Record<string, unknown>).title, 'hello')

    await c.remove.mutate({ path: '/test' })
    assert.equal(await c.get.query({ path: '/test' }), undefined)
  })

  it('getChildren with pagination', async () => {
    const c = createClient(ctx.url)
    await c.set.mutate({ node: { $path: '/parent', $type: 'dir' } })
    await c.set.mutate({ node: { $path: '/parent/a', $type: 'doc' } })
    await c.set.mutate({ node: { $path: '/parent/b', $type: 'doc' } })
    await c.set.mutate({ node: { $path: '/parent/c', $type: 'doc' } })

    const page = await c.getChildren.query({ path: '/parent', limit: 2 })
    assert.equal(page.items.length, 2)
    assert.equal(page.total, 3)
  })

  it('auth: register → login → me', async () => {
    const c = createClient(ctx.url)
    const reg = await c.register.mutate({ userId: 'tester', password: 'pass' })
    assert.ok(reg.token)

    const login = await c.login.mutate({ userId: 'tester', password: 'pass' })
    assert.ok(login.token)

    const me = await createClient(ctx.url, login.token).me.query()
    assert.equal(me?.userId, 'tester')
  })

  it('NOT_FOUND on missing node', async () => {
    const c = createClient(ctx.url)
    await assert.rejects(
      () => c.execute.mutate({ path: '/ghost', action: 'nope' }),
      (e: unknown) => (e as { data?: { code?: string } }).data?.code === 'NOT_FOUND',
    )
  })
})

// -- Public ACL: agent-runtime template --

describe('e2e: treerun agent-runtime (public)', () => {
  let ctx: Ctx

  before(async () => { ctx = await boot(agentRuntimeSeed, undefined, { publicAccess: true }) })
  after(async () => {
    await shutdown(ctx)
    rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('seed: agent pool', async () => {
    const c = createClient(ctx.url)
    const pool = await c.get.query({ path: '/agents' })
    assert.ok(pool)
    assert.equal(pool.$type, 'ai.pool')
    assert.equal((pool as Record<string, unknown>).maxConcurrent, 2)
  })

  it('seed: guardian with policy', async () => {
    const c = createClient(ctx.url)
    const guardian = await c.get.query({ path: '/agents/guardian' })
    assert.ok(guardian)
    const policy = (guardian as Record<string, unknown>).policy as Record<string, unknown>
    assert.ok(policy)
    assert.ok(Array.isArray(policy.allow))
    assert.ok(Array.isArray(policy.deny))
    assert.ok(Array.isArray(policy.escalate))
  })

  it('seed: QA + Dev agents', async () => {
    const c = createClient(ctx.url)
    for (const name of ['qa', 'dev']) {
      const agent = await c.get.query({ path: `/agents/${name}` })
      assert.ok(agent, `${name} agent should exist`)
      assert.equal(agent.$type, 'ai.agent')
      assert.equal((agent as Record<string, unknown>).role, name)
    }
  })

  it('seed: board + column + sample task', async () => {
    const c = createClient(ctx.url)

    const board = await c.get.query({ path: '/board' })
    assert.equal(board?.$type, 'board.kanban')

    const backlog = await c.get.query({ path: '/board/backlog' })
    assert.equal(backlog?.$type, 'board.column')

    const tasks = await c.getChildren.query({ path: '/board/data' })
    assert.ok(tasks.items.length >= 1)
    assert.equal(tasks.items[0].$type, 'board.task')
  })

  it('CRUD works alongside seed data', async () => {
    const c = createClient(ctx.url)
    await c.set.mutate({
      node: {
        $path: '/board/data/e2e-task', $type: 'board.task',
        title: 'E2E', status: 'todo', description: '', assignee: '',
        priority: 'normal', result: '', createdAt: Date.now(), updatedAt: Date.now(),
      },
    })

    const tasks = await c.getChildren.query({ path: '/board/data' })
    assert.ok(tasks.items.length >= 2)
    assert.ok(tasks.items.some(n => n.$path === '/board/data/e2e-task'))
  })
})

// -- Persistence: data survives server restart --

describe('e2e: treerun persistence', () => {
  let tmpDir: string
  const ctxs: Ctx[] = []

  before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'treerun-persist-')) })
  after(async () => {
    for (const ctx of ctxs) await shutdown(ctx).catch(() => {})
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('data survives restart, seed is idempotent', async () => {
    // Boot 1: seed + write extra data
    const ctx1 = await boot(agentRuntimeSeed, tmpDir, { publicAccess: true })
    ctxs.push(ctx1)
    const c1 = createClient(ctx1.url)
    await c1.set.mutate({ node: { $path: '/persist-check', $type: 'doc', survived: true } })

    const saved = await c1.get.query({ path: '/persist-check' })
    assert.ok(saved)
    await shutdown(ctx1)
    ctxs.length = 0

    // Boot 2: same dataDir — seed checks /agents and skips (idempotent)
    const ctx2 = await boot(agentRuntimeSeed, tmpDir, { publicAccess: true })
    ctxs.push(ctx2)
    const c2 = createClient(ctx2.url)

    // Seed data survived
    const agents = await c2.get.query({ path: '/agents' })
    assert.ok(agents, 'Seed data should persist across restart')
    assert.equal(agents.$type, 'ai.pool')

    // Custom data survived
    const persisted = await c2.get.query({ path: '/persist-check' })
    assert.ok(persisted, 'Custom data should persist across restart')
    assert.equal((persisted as Record<string, unknown>).survived, true)

    await shutdown(ctx2)
    ctxs.length = 0
  })
})
