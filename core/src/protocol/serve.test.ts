import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import type { Position } from '#kernel/types'
import { createTwpServing } from '#protocol/serve'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
async function setup() {
  const root = createMemoryStore({ domain: 'native-serving' })
  let saved: Position | undefined, nonce = 0
  const instance = await createInstanceFoundation({ id: 'native-serving', root, writerEpoch: 1,
    domains: [{ store: root, epoch: 'serving1', persistent: true }], counter: {
      async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 },
    }, budget: scanBudget, firstAdmin: { path: '/admin', name: 'admin', password: 'serving-password' }, initialCredential: { ttlMs: 60_000 } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential)), serving = createTwpServing(instance)
  return { instance, serving,
    limits(values: Record<string, number>) { return admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++nonce) },
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: values } }] }) },
    close() { serving.close(); admin.close(); instance.auth.close() } }
}

describe('native serving lifecycle', () => {
  it('does not retain a lane slot after synchronous heartbeat expiry during construction', async t => {
    const f = await setup(); t.after(() => f.close())
    await f.limits({ heartbeatMs: 0, maxLanes: 1 })
    await assert.rejects(f.serving.open({ t: 'hi' }, undefined, '127.0.0.1'), code('UNAVAILABLE'))
    await f.limits({ heartbeatMs: 30_000 })
    const opened = await f.serving.open({ t: 'hi' }, undefined, '127.0.0.1')
    assert.ok(opened.id && opened.credential)
  })
  it('counts anonymous IPv6 origins by prefix and frees their slot on detach', async t => {
    const f = await setup(); t.after(() => f.close())
    await f.limits({ lanesPerOrigin: 2 })
    const first = await f.serving.open({ t: 'hi' }, undefined, '2001:db8:abcd:12::1')
    await f.serving.open({ t: 'hi' }, undefined, '2001:db8:abcd:12::2')
    await assert.rejects(f.serving.open({ t: 'hi' }, undefined, '2001:db8:abcd:12::3'), code('BUDGET'))
    assert.ok(first.credential)
    const attached = f.serving.attach(first.id, first.credential, '2001:db8:abcd:12::1')
    const welcome = await attached.frames[Symbol.asyncIterator]().next()
    assert.ok(welcome.done === false && welcome.value.t === 'welcome')
    attached.close()
    assert.ok((await f.serving.open({ t: 'hi' }, undefined, '2001:db8:abcd:12::3')).id)
  })
  it('refuses duplicate readers and releases authorization when serving closes', async t => {
    const f = await setup(); t.after(() => f.close())
    const opened = await f.serving.open({ t: 'hi' }, undefined, '127.0.0.1'); assert.ok(opened.credential)
    f.serving.attach(opened.id, opened.credential, '127.0.0.1')
    assert.throws(() => f.serving.attach(opened.id, opened.credential, '127.0.0.1'), code('CONFLICT'))
    f.serving.close()
    assert.throws(() => f.serving.dispatch(opened.id, opened.credential, '127.0.0.1', []), code('UNAVAILABLE'))
  })
})
