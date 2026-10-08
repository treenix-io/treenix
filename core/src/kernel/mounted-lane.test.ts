import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import { comparePositions } from '#kernel/position'
import { createMemoryStore } from '#kernel/store/memory'
import type { ChangeMember, Position } from '#kernel/types'

/** Uses real sessions and memory targets while keeping the borrowed counter explicit. */
async function setup() {
  const root = createMemoryStore({ domain: randomUUID() })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: randomUUID(), root, writerEpoch: 1,
    domains: [{ store: root, epoch: randomUUID(), persistent: false }],
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    firstAdmin: { path: '/admin', name: 'admin', password: 'mounted-lane-password' },
    initialCredential: { ttlMs: 60_000 } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))

  /** Supplies the currently announced intake epoch for each new mutation. */
  function key() {
    return { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() }
  }

  /** Makes setup writes through the same native command producer used by sessions. */
  function commit(changes: readonly ChangeMember[]) {
    return admin.commit({ changes, opId: key() })
  }

  await commit([
    { op: 'put', node: { $path: '/data', $type: 't.dir' } },
    { op: 'put', node: { $path: '/stable', $type: 't.dir', value: 1 } },
  ])
  return { instance, admin, key, commit }
}

describe('mounted lane topology and intake lifetime', { timeout: 10_000 }, () => {
  it('resets an intersecting empty child range while preserving an unrelated subscription', async t => {
    const f = await setup()
    t.after(() => f.instance.close())

    const lane = await f.instance.openSession(f.instance.setupCredential)
    assert.equal((await lane.frames.next()).value?.t, 'welcome')
    const stable = lane.sub({ node: '/stable' })
    const stableSnap = await lane.frames.next()
    assert.ok(stableSnap.done === false && stableSnap.value.t === 'snap')
    const stableId = stableSnap.value.list[0]
    const children = lane.sub({ children: '/data' })
    const childrenSnap = await lane.frames.next()
    assert.ok(childrenSnap.done === false && childrenSnap.value.t === 'snap')
    assert.deepEqual(childrenSnap.value.list, [])

    await f.commit([{ op: 'patch', path: '/data',
      ops: { $set: { '#mount': { $type: 't.mount.memory', pattern: 'new' } } } }])

    const reset = await lane.frames.next()
    assert.ok(reset.done === false && reset.value.t === 'reset')
    assert.equal(reset.value.sub, children)
    const replacement = await lane.frames.next()
    assert.ok(replacement.done === false && replacement.value.t === 'snap')
    assert.equal(replacement.value.sub, children)
    assert.ok(replacement.value.gen > childrenSnap.value.gen)

    const accepted = await f.commit([{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }])
    const progress = await lane.frames.next()
    assert.equal(progress.value?.t, 'pos')
    assert.ok(progress.done === false && progress.value.t === 'pos')
    assert.deepEqual(progress.value.pos, accepted.pos)
    assert.ok(progress.value.changes.some(change => change.op === 'patch'
      && change.id === stableId))
    assert.notEqual(stable, children)
  })

  it('refuses a selector precondition whose root range was shadowed by a new mount', async t => {
    const f = await setup()
    t.after(() => f.instance.close())

    const selector = { children: '/data' }
    const before = await f.admin.read(selector)
    await f.commit([{ op: 'patch', path: '/data',
      ops: { $set: { '#mount': { $type: 't.mount.memory', pattern: 'new' } } } }])
    await assert.rejects(f.admin.commit({ opId: f.key(),
      expect: { selectors: [{ selector, at: before.at }] },
      changes: [{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }],
    }), error => error instanceof KernelError && error.code === 'CONFLICT')

    const copy = (await f.admin.read({ node: '/stable' })).copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.value, 1)
  })

  it('finishes an accepted Pending before reconnecting with one fresh welcome', async t => {
    const f = await setup()
    t.after(() => f.instance.close())

    const lane = await f.instance.openSession(f.instance.setupCredential)
    const welcome = await lane.frames.next()
    assert.ok(welcome.done === false && welcome.value.t === 'welcome')
    lane.sub({ node: '/stable' })
    assert.equal((await lane.frames.next()).value?.t, 'snap')
    const request = { opId: f.key(), changes: [
      { op: 'patch' as const, path: '/stable', ops: { $inc: { value: 1 } } },
    ] }
    let acknowledge: () => void = () => { throw new Error('Commit observer is not initialized') }
    const recorded = new Promise<void>(resolve => { acknowledge = resolve })
    const unsubscribe = f.instance.writer.stream.observe(event => {
      if (event.t === 'commit' && event.record.decision?.opId.nonce === request.opId.nonce) acknowledge()
    })
    t.after(unsubscribe)

    const pending = lane.commit(request)
    await recorded
    await f.instance.writer.refreshIntake(true)
    assert.notEqual(f.instance.writer.intake.epoch, welcome.value.intake)

    const progress = await lane.frames.next()
    assert.ok(progress.done === false && progress.value.t === 'pos')
    const completed = await lane.frames.next()
    assert.ok(completed.done === false && completed.value.t === 'done')
    assert.equal(completed.value.req, pending.id)
    const outcome = await pending.outcome
    assert.ok(outcome.pos)
    assert.ok(comparePositions(progress.value.pos, outcome.pos) >= 0)
    assert.deepEqual(completed.value.pos, outcome.pos)
    assert.equal((await lane.frames.next()).done, true)
    assert.deepEqual(await f.admin.commit(request), outcome)

    const next = await f.instance.openSession(f.instance.setupCredential)
    const fresh = await next.frames.next()
    assert.ok(fresh.done === false && fresh.value.t === 'welcome')
    assert.equal(fresh.value.intake, f.instance.writer.intake.epoch)
    next.sub({ node: '/stable' })
    assert.equal((await next.frames.next()).value?.t, 'snap')
  })
})
