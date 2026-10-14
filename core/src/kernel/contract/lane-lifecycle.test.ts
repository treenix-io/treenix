import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { prepareCredential } from '#kernel/auth/credentials'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import type { NodeLane } from '#kernel/lane'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import { DEFAULT_LIMITS, R, type ChangeMember, type Position } from '#kernel/types'

/** Match public refusal codes without depending on diagnostic text. */
function code(expected: KernelError['code']) {
  return (error: unknown) => error instanceof KernelError && error.code === expected
}

/** Own one genuine ephemeral deployment and deliver its bootstrap admin's accepted mutations. */
async function fixture() {
  const id = randomUUID()
  const root = createMemoryStore({ domain: id })
  let saved: Position | undefined
  const instance = await createInstance({ id, root: { kind: 'store', store: root },
    provisioning: { writerEpoch: 1, domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      counter: { async load() { return saved }, async save(pos) { saved = pos },
        async freshEpoch(floor) { return floor + 1 } },
      credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } } },
    blobs: createMemoryBlobStore(), modules: [] })
  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential)
  const delivery = drainSession(admin)

  /** Commit through the production Session while its actual lane consumes completion frames. */
  function commit(changes: readonly ChangeMember[]) {
    return admin.commit({ changes, opId: {
      epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID(),
    } }).outcome
  }

  /** Provision two independent genuine credentials for one accepted account identity. */
  async function account(name: string) {
    const path = `/${name}`
    await commit([{ op: 'put', node: { $path: path, $type: 't.user', name, status: 'active',
      '#groups': { $type: 't.groups', list: ['readers'] } } }])
    const copy = (await admin.read({ node: path })).copies[0]
    assert.ok('node' in copy)
    const first = prepareCredential(copy.node.$id, { expiresAt: Date.now() + 60_000 })
    const second = prepareCredential(copy.node.$id, { expiresAt: Date.now() + 60_000 })
    await commit([{ op: 'put', node: first.node }, { op: 'put', node: second.node }])
    return { path, first, second }
  }

  /** End the real deployment before awaiting its delivery task. */
  async function close() {
    await instance.close()
    await delivery
  }

  return { instance, admin, commit, account, close }
}

/** Consume a real welcome before using a newly admitted lane. */
async function welcome(session: NodeLane) {
  const frame = await session.frames.next()
  assert.ok(!frame.done && frame.value.t === 'welcome')
  return frame.value
}

describe('native lane quota, topology and actor lifetime', { timeout: 15_000 }, () => {
  it('refuses the seventeenth anonymous lane from one origin and releases its quota on close', async t => {
    const f = await fixture()
    t.after(f.close)
    assert.equal(DEFAULT_LIMITS.lanesPerOrigin, 16)
    const sessions: NodeLane[] = []
    for (let index = 0; index < 16; index++) {
      const session = await f.instance.openSession(undefined, '192.0.2.10')
      const opened = await welcome(session)
      assert.ok(opened.credential)
      sessions.push(session)
    }
    assert.equal(new Set(sessions.map(session => session.actor.principal)).size, 16)
    await assert.rejects(f.instance.openSession(undefined, '192.0.2.10'), code('BUDGET'))
    const otherOrigin = await f.instance.openSession(undefined, '192.0.2.11')
    await welcome(otherOrigin)
    sessions[0].close()
    assert.equal((await sessions[0].frames.next()).done, true)
    const replacement = await f.instance.openSession(undefined, '192.0.2.10')
    await welcome(replacement)
    await assert.rejects(f.instance.openSession(undefined, '192.0.2.10'), code('BUDGET'))
  })

  it('shares credentialed quota by principal across tokens and origins while keeping other principals independent', async t => {
    const f = await fixture()
    t.after(f.close)
    const a = await f.account('alice'), b = await f.account('bob')
    const sessions: NodeLane[] = []
    for (let index = 0; index < 16; index++) {
      const credential = index % 2 === 0 ? a.first.credential : a.second.credential
      const session = await f.instance.openSession(credential, index % 2 === 0 ? '192.0.2.10' : '192.0.2.11')
      await welcome(session)
      sessions.push(session)
    }
    assert.equal(new Set(sessions.map(session => session.actor.principal)).size, 1)
    await assert.rejects(f.instance.openSession(a.second.credential, '192.0.2.12'), code('BUDGET'))
    const other = await f.instance.openSession(b.first.credential, '192.0.2.10')
    await welcome(other)
    assert.notEqual(other.actor.principal, sessions[0].actor.principal)
    sessions[0].close()
    assert.equal((await sessions[0].frames.next()).done, true)
    await welcome(await f.instance.openSession(a.second.credential, '192.0.2.12'))
  })

  it('enforces the global lane ceiling across independent origin buckets and releases a reservation after refusal', async t => {
    const f = await fixture()
    t.after(f.close)
    await f.commit([{ op: 'put', node: { $path: '/sys/limits', $type: 't.limits', maxLanes: 3 } }])
    const first = await f.instance.openSession(undefined, '192.0.2.10')
    const second = await f.instance.openSession(undefined, '192.0.2.11')
    await welcome(first)
    await welcome(second)
    await assert.rejects(f.instance.openSession(undefined, '192.0.2.12'), code('BUDGET'))
    first.close()
    assert.equal((await first.frames.next()).done, true)
    await welcome(await f.instance.openSession(undefined, '192.0.2.12'))
    await assert.rejects(f.instance.openSession(undefined, '192.0.2.13'), code('BUDGET'))
  })

  it('renews descendant generations when an ancestor of a declared mount moves while unrelated coverage remains live', async t => {
    const f = await fixture()
    t.after(f.close)
    await f.commit([
      { op: 'put', node: { $path: '/a', $type: 't.dir' } },
      { op: 'put', node: { $path: '/a/b', $type: 't.dir', '#mount': { $type: 't.mount.memory', pattern: '' } } },
      { op: 'put', node: { $path: '/stable', $type: 't.dir', value: 1 } },
    ])
    await f.commit([
      { op: 'put', node: { $path: '/a/b/c', $type: 't.dir', value: 7 } },
      { op: 'put', node: { $path: '/a/b/c/item', $type: 't.dir', value: 8 } },
    ])
    const lane = await f.instance.openSession(f.instance.setupCredential)
    await welcome(lane)
    const stable = lane.sub({ node: '/stable' })
    const stableFrame = await lane.frames.next()
    assert.ok(!stableFrame.done && stableFrame.value.t === 'snap')
    const stableId = stableFrame.value.list[0], stableGen = stableFrame.value.gen
    const node = lane.sub({ node: '/a/b/c' })
    const nodeFrame = await lane.frames.next()
    assert.ok(!nodeFrame.done && nodeFrame.value.t === 'snap' && nodeFrame.value.list.length === 1)
    const children = lane.sub({ children: '/a/b/c' })
    const childFrame = await lane.frames.next()
    assert.ok(!childFrame.done && childFrame.value.t === 'snap' && childFrame.value.list.length === 1)

    await f.commit([{ op: 'move', from: '/a', to: '/moved' }])
    const resets = new Map<string, number>()
    let nodeEnded = false, childrenEmpty = false
    for (let index = 0; index < 12 && (!nodeEnded || !childrenEmpty || resets.size !== 2); index++) {
      const frame = await lane.frames.next()
      assert.ok(!frame.done)
      const value = frame.value
      if (value.t === 'reset') {
        assert.notEqual(value.sub, stable)
        assert.ok(value.sub === node || value.sub === children)
        resets.set(value.sub, value.gen)
      } else if (value.t === 'end') {
        assert.equal(value.sub, node)
        assert.equal(value.error.code, 'NOT_FOUND')
        nodeEnded = true
      } else if (value.t === 'snap') {
        assert.equal(value.sub, children)
        assert.ok(value.gen > childFrame.value.gen)
        assert.deepEqual(value.list, [])
        childrenEmpty = true
      } else assert.equal(value.t, 'pos')
    }
    assert.ok(nodeEnded && childrenEmpty)
    assert.ok(resets.get(node)! > nodeFrame.value.gen)
    assert.ok(resets.get(children)! > childFrame.value.gen)
    const accepted = await f.commit([{ op: 'patch', path: '/stable', ops: { $set: { value: 2 } } }])
    let stableUpdated = false
    for (let index = 0; index < 8 && !stableUpdated; index++) {
      const frame = await lane.frames.next()
      assert.ok(!frame.done && frame.value.t === 'pos')
      stableUpdated = frame.value.changes.some(change => change.op === 'patch' && change.id === stableId)
      if (stableUpdated) assert.deepEqual(frame.value.pos, accepted.pos)
      for (const change of frame.value.changes)
        if (change.op === 'list' && change.sub === stable) assert.equal(change.gen, stableGen)
    }
    assert.ok(stableUpdated)
    const copy = (await lane.read({ node: '/stable' })).copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.value, 2)
  })

  for (const change of ['groups', 'scope'] as const) it(`closes active caller lanes on ${change} changes and admits only the new actor`, async t => {
    const f = await fixture()
    t.after(f.close)
    const account = await f.account('reader')
    await f.commit([
      { op: 'put', node: { $path: '/sys/limits', $type: 't.limits', lanesPerOrigin: 2 } },
      { op: 'put', node: { $path: '/visible', $type: 't.dir', value: 1,
        $acl: [{ subject: { group: 'readers' }, grant: R }] } },
      { op: 'put', node: { $path: '/other', $type: 't.dir', value: 2,
        $acl: [{ subject: { group: 'readers' }, grant: R }] } },
    ])
    const lane = await f.instance.openSession(account.first.credential)
    const unrelated = await f.instance.openSession(account.second.credential)
    await welcome(lane)
    await welcome(unrelated)
    await assert.rejects(f.instance.openSession(account.first.credential), code('BUDGET'))
    lane.sub({ node: '/visible' })
    const snapshot = await lane.frames.next()
    assert.ok(!snapshot.done && snapshot.value.t === 'snap' && snapshot.value.list.length === 1)
    const pulling = lane.frames.next()
    const rejectedPull = assert.rejects(pulling, code('UNAUTHENTICATED'))
    await f.commit(change === 'groups'
      ? [{ op: 'patch', path: account.path, ops: { $set: { '#groups.list': ['other-group'] } } }]
      : [{ op: 'patch', path: account.first.node.$path, ops: { $set: { scope: ['/visible'] } } }])
    await rejectedPull
    await assert.rejects(lane.frames.next(), code('UNAUTHENTICATED'))
    await assert.rejects(async () => lane.read({ node: '/visible' }), code('UNAUTHENTICATED'))
    await f.commit([{ op: 'patch', path: '/visible', ops: { $set: { value: 999 } } }])
    await assert.rejects(lane.frames.next(), code('UNAUTHENTICATED'))
    assert.equal((await lane.frames.return?.())?.done, true)
    const fresh = await f.instance.openSession(account.first.credential)
    await welcome(fresh)
    if (change === 'groups') {
      assert.ok(fresh.actor.claims.includes('other-group'))
      assert.ok(!fresh.actor.claims.includes('readers'))
      await assert.rejects(fresh.read({ node: '/visible' }), code('NOT_FOUND'))
      await assert.rejects(async () => unrelated.read({ node: '/visible' }), code('UNAUTHENTICATED'))
    } else {
      assert.deepEqual(fresh.actor.scope, ['/visible'])
      const allowed = (await fresh.read({ node: '/visible' })).copies[0]
      assert.ok('node' in allowed)
      assert.equal(allowed.node.value, 999)
      await assert.rejects(fresh.read({ node: '/other' }), code('NOT_FOUND'))
      const other = (await unrelated.read({ node: '/other' })).copies[0]
      assert.ok('node' in other)
      assert.equal(other.node.value, 2)
    }
  })
})
