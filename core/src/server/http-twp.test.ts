import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createInstanceFoundation } from '#kernel/instance'
import { openPersistentWriter } from '#kernel/persistence'
import { createFsStore } from '#kernel/store/fs'
import { scanBudget } from '#kernel/store/contract'
import type { Frame, ModuleManifest, Operation, Request } from '#kernel/types'
import { networkAddress } from '#protocol/serve'
import { decodeFrame, decodeJson, isReadResult } from '#protocol/twp'
import { createTwpHttpServer, writeSse } from '#server/http-twp'
import { isRecord } from '#util/is-record'

const app = 'http://app.test'
interface StreamingRequestInit extends RequestInit { readonly duplex: 'half' }
const module: ModuleManifest = { id: 'http-test', types: [{ name: 'http.counter', module: 'http-test', security: 'ordinary', version: 0,
  schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false },
  actions: { increment: { kind: 'write', args: { type: 'object', additionalProperties: false }, post: { '': { $inc: { count: 1 } } } } } }], security: [], open: [] }

async function setup(options: { directory?: string; trustProxy?: boolean } = {}) {
  const parent = fileURLToPath(new URL('../../../../temp/k37-http-datasets/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const directory = options.directory ?? await mkdtemp(join(parent, 'dataset-'))
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'http-test' })
  const store = await createFsStore({ directory, lease })
  const observed: Operation[] = []
  const instance = await createInstanceFoundation({ id: 'http-test', root: store, writerEpoch: lease.writerEpoch, counter: lease,
    domains: [{ store, epoch: lease.epoch, persistent: true }], budget: scanBudget, initialCredential: { ttlMs: 60_000 },
    ...(options.directory === undefined ? { firstAdmin: { path: '/admin', name: 'admin', password: 'http-test-password' } } : {}),
    gates: [async operation => { observed.push(operation); return 'pass' }] })
  let nonce = 0
  const key = () => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: `http-${++nonce}` })
  if (options.directory === undefined) {
    assert.ok(instance.setupCredential)
    const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
    await admin.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/sys/types/http.counter', $type: 't.type', name: 'http.counter', module: module.id, security: 'ordinary' } }] })
    instance.registry.publish(module)
    await admin.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/counter', $type: 'http.counter', count: 0 } }] })
    admin.close()
  } else instance.registry.publish(module)
  const http = createTwpHttpServer({ instance, allowedOrigins: [app], trustProxy: options.trustProxy, credentialTtlMs: 60_000 })
  http.server.listen(0, '127.0.0.1'); await once(http.server, 'listening')
  const address = http.server.address(); assert.ok(address !== null && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  let closed = false
  return { directory, instance, observed, url, key,
    async post(path: string, value: unknown, headers: Record<string, string> = {}) {
      return fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
    },
    async close() { if (closed) return; closed = true; await http.close(); instance.auth.close(); await store.close(); await lease.close() } }
}
async function login(f: Awaited<ReturnType<typeof setup>>, scope?: readonly string[]) {
  const response = await f.post('/auth/login', { account: '/admin', password: 'http-test-password', ...(scope === undefined ? {} : { scope }) })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie'); assert.ok(cookie)
  assert.ok(cookie.includes('HttpOnly; Secure; SameSite=Strict'))
  const credential = decodeJson(await response.text(), 4096); assert.ok(isRecord(credential) && typeof credential.token === 'string')
  return { token: credential.token, cookie: cookie.split(';')[0] }
}
async function openLane(f: Awaited<ReturnType<typeof setup>>, token: string, extra: Record<string, string> = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...extra }
  const response = await f.post('/twp', { t: 'hi' }, headers); assert.equal(response.status, 201)
  const opening = decodeJson(await response.text(), 4096); assert.ok(isRecord(opening) && typeof opening.lane === 'string')
  const id = opening.lane, controller = new AbortController()
  const stream = await fetch(`${f.url}/twp/lane/${id}`, { headers, signal: controller.signal }); assert.equal(stream.status, 200)
  assert.ok(stream.body)
  const reader = stream.body.getReader(), decoder = new TextDecoder(), frames: Frame[] = []
  let buffer = ''
  return { id, frames,
    async next(): Promise<Frame> {
      while (!buffer.includes('\n\n')) {
        const part = await reader.read(); assert.equal(part.done, false)
        buffer += decoder.decode(part.value, { stream: true })
      }
      const end = buffer.indexOf('\n\n'), record = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      assert.ok(record.startsWith('data: '))
      const frame = decodeFrame(record.slice(6), 16 * 1024 * 1024); frames.push(frame)
      return frame
    },
    async send(request: Request | readonly Request[]) { return f.post('/twp', request, { ...headers, 'TWP-Lane': id }) },
    close() { controller.abort() },
  }
}

describe('real native HTTP binding', { timeout: 30_000 }, () => {
  it('orders subscription positions before outcomes and reopens durable writes and replay after restart', async t => {
    const first = await setup(); t.after(() => first.close())
    const signed = await login(first), lane = await openLane(first, signed.token); t.after(() => lane.close())
    assert.equal((await lane.next()).t, 'welcome')
    assert.equal((await lane.send({ t: 'sub', sub: 'counter', selector: { node: '/counter' } })).status, 202)
    assert.equal((await lane.next()).t, 'snap')
    const commit: Extract<Request, { t: 'commit' }> = { t: 'commit', req: 'save', opId: first.key(), changes: [{ op: 'patch', path: '/counter', ops: { $inc: { count: 1 } } }] }
    assert.equal((await lane.send(commit)).status, 202)
    const applied = await lane.next(), done = await lane.next()
    assert.equal(applied.t, 'pos'); assert.ok(done.t === 'done')
    assert.equal(done.req, 'save'); assert.ok(done.pos); assert.ok(applied.t === 'pos'); assert.deepEqual(done.pos, applied.pos)
    const act: Extract<Request, { t: 'act' }> = { t: 'act', req: 'action', path: '/counter', action: 'increment', args: {}, opId: first.key() }
    assert.equal((await lane.send(act)).status, 202)
    assert.equal((await lane.next()).t, 'pos'); assert.equal((await lane.next()).t, 'done')
    lane.close(); await first.close()
    const second = await setup({ directory: first.directory }); t.after(() => second.close())
    assert.equal(second.instance.setupCredential, undefined)
    const again = await login(second), current = await openLane(second, again.token); t.after(() => current.close())
    assert.equal((await current.next()).t, 'welcome')
    assert.equal((await current.send({ ...commit, req: 'replay' })).status, 202)
    const covering = await current.next(); assert.ok(covering.t === 'pos'); assert.equal(covering.coverage, undefined)
    const replay = await current.next(); assert.ok(replay.t === 'done'); assert.deepEqual(replay.pos, done.pos)
    assert.equal((await current.send({ t: 'read', req: 'read', selector: { node: '/counter' } })).status, 202)
    const read = await current.next(); assert.ok(read.t === 'done' && isReadResult(read.value))
    const copy = read.value.copies[0]; assert.ok('node' in copy); assert.equal(copy.node.count, 2)
  })
  it('rejects malformed or unsupported batches before the first effect', async t => {
    const f = await setup(); t.after(() => f.close())
    const signed = await login(f), lane = await openLane(f, signed.token); t.after(() => lane.close()); await lane.next()
    const mutation = { t: 'commit', req: 'before-invalid', opId: f.key(), changes: [{ op: 'patch', path: '/counter', ops: { $set: { count: 99 } } }] }
    for (const suffix of [{ t: 'unknown' }, { t: 'read', req: 'history', selector: { history: 12 } }]) {
      const response = await f.post('/twp', [mutation, suffix], { Authorization: `Bearer ${signed.token}`, 'TWP-Lane': lane.id })
      assert.equal(response.status, 400); const error = decodeFrame(await response.text(), 4096); assert.ok(error.t === 'fail'); assert.equal(error.error.code, 'INVALID')
    }
    assert.equal((await lane.send({ t: 'read', req: 'after', selector: { node: '/counter' } })).status, 202)
    const read = await lane.next(); assert.ok(read.t === 'done' && isReadResult(read.value)); const copy = read.value.copies[0]
    assert.ok('node' in copy); assert.equal(copy.node.count, 0)
    assert.equal((await lane.send({ t: 'read', req: 'missing', selector: { node: '/absent' } })).status, 202)
    const failure = await lane.next(); assert.ok(failure.t === 'fail'); assert.equal(failure.error.code, 'NOT_FOUND')
    assert.equal((await lane.send({ t: 'read', req: 'healthy', selector: { node: '/counter' } })).status, 202)
    assert.equal((await lane.next()).t, 'done')
  })
  it('reads administrative history through native HTTP lanes with exclusive cursor pages', async t => {
    const f = await setup(); t.after(() => f.close())
    const signed = await login(f), lane = await openLane(f, signed.token); t.after(() => lane.close())
    await lane.next()
    assert.equal((await lane.send({ t: 'commit', req: 'change', opId: f.key(),
      changes: [{ op: 'patch', path: '/counter', ops: { $inc: { count: 1 } } }] })).status, 202)
    assert.equal((await lane.next()).t, 'pos')
    assert.equal((await lane.next()).t, 'done')
    assert.equal((await lane.send({ t: 'read', req: 'history', selector: { history: '/counter', window: { limit: 1 } } })).status, 202)
    const first = await lane.next(); assert.ok(first.t === 'done' && isReadResult(first.value))
    assert.equal(first.value.history?.length, 1); assert.ok(first.value.next)
    assert.equal(first.value.history[0].after?.count, 0)
    assert.equal((await lane.send({ t: 'read', req: 'next', selector: { history: '/counter', window: { limit: 1, after: first.value.next } } })).status, 202)
    const second = await lane.next(); assert.ok(second.t === 'done' && isReadResult(second.value))
    assert.equal(second.value.history?.length, 1)
    const entry = second.value.history[0]; assert.ok(entry.before !== 'unknown')
    assert.equal(entry.before?.count, 0); assert.equal(entry.after?.count, 1)
    assert.equal(entry.opId?.nonce.startsWith('http-'), true)
  })
  it('binds attachment to the original credential and refuses invalid auth without an anonymous downgrade', async t => {
    const f = await setup(); t.after(() => f.close())
    const full = await login(f), narrow = await login(f, ['/counter']), lane = await openLane(f, full.token); t.after(() => lane.close()); await lane.next()
    const attach = await fetch(`${f.url}/twp/lane/${lane.id}`, { headers: { Authorization: `Bearer ${narrow.token}` } })
    assert.equal(attach.status, 401); const denied = decodeFrame(await attach.text(), 4096); assert.ok(denied.t === 'fail'); assert.equal(denied.error.code, 'UNAUTHENTICATED')
    assert.equal((await f.post('/twp', [], { Authorization: `Bearer ${narrow.token}`, 'TWP-Lane': lane.id })).status, 401)
    const invalid = await f.post('/twp', { t: 'hi' }, { Authorization: `Bearer ${'0'.repeat(64)}` })
    assert.equal(invalid.status, 401); const error = decodeFrame(await invalid.text(), 4096); assert.ok(error.t === 'fail'); assert.equal(error.error.code, 'UNAUTHENTICATED')
    assert.equal((await lane.send({ t: 'read', req: 'still-active', selector: { node: '/counter' } })).status, 202)
    assert.equal((await lane.next()).t, 'done')
  })
  it('limits chunked request bytes and enforces cookie origin and trusted proxy boundaries', async t => {
    const f = await setup(); t.after(() => f.close())
    const signed = await login(f)
    assert.equal((await f.post('/twp', { t: 'hi' }, { Cookie: signed.cookie })).status, 403)
    assert.equal((await f.post('/twp', { t: 'hi' }, { Cookie: signed.cookie, Origin: 'http://foreign.test' })).status, 403)
    const cookie = await f.post('/twp', { t: 'hi' }, { Cookie: signed.cookie, Origin: app }); assert.equal(cookie.status, 201)
    assert.equal(cookie.headers.get('access-control-allow-origin'), app)
    const streaming: StreamingRequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: new Blob(['!'.repeat(513 * 1024)]).stream(), duplex: 'half' }
    const response = await fetch(`${f.url}/twp`, streaming)
    assert.equal(response.status, 413); const error = decodeFrame(await response.text(), 4096); assert.ok(error.t === 'fail'); assert.equal(error.error.code, 'BUDGET')
    const lane = await openLane(f, signed.token, { 'X-Forwarded-For': 'spoofed, invalid' }); t.after(() => lane.close()); await lane.next()
    await lane.send({ t: 'read', req: 'ip', selector: { node: '/counter' } }); await lane.next()
    assert.equal(f.observed.at(-1)?.origin, '127.0.0.1')
    const proxy = await setup({ trustProxy: true }); t.after(() => proxy.close())
    const proxySigned = await login(proxy), peer = await openLane(proxy, proxySigned.token, { 'X-Forwarded-For': 'spoofed, 203.0.113.12' }); t.after(() => peer.close()); await peer.next()
    await peer.send({ t: 'read', req: 'proxy', selector: { node: '/counter' } }); await peer.next()
    assert.equal(proxy.observed.at(-1)?.origin, '203.0.113.12')
    assert.equal(networkAddress('2001:db8:abcd:12::1').bucket, networkAddress('2001:db8:abcd:12::ffff').bucket)
    assert.deepEqual(networkAddress('::ffff:127.0.0.1'), networkAddress('127.0.0.1'))
  })
  it('stops pulling native output until the real socket drains', async t => {
    let pulled = 0
    let finished!: () => void
    const drained = new Promise<void>(resolve => { finished = resolve }), controller = new AbortController()
    async function* frames(): AsyncGenerator<Frame> {
      pulled++; yield { t: 'done', req: 'large', value: 'x'.repeat(8 * 1024 * 1024) }
      pulled++; finished(); yield { t: 'done', req: 'after-drain' }
    }
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      writeSse(response, frames(), controller.signal).then(() => response.end(), error => { console.error(error); response.destroy() })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address !== null && typeof address === 'object')
    const socket = connect(address.port, '127.0.0.1')
    t.after(async () => { socket.destroy(); controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    await once(socket, 'connect'); socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    await once(socket, 'data'); socket.pause(); assert.equal(pulled, 1)
    socket.resume(); await drained; assert.equal(pulled, 2)
  })
})
