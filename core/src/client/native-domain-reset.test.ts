import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it, type TestContext } from 'node:test'
import { createTwpClient } from '#client/twp'
import { KernelError } from '#errors'
import { credentialPath } from '#kernel/auth/crypto'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { comparePositions } from '#kernel/position'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import { applyDelta } from '#kernel/update-ops'
import type {
  ChangeMember,
  CommitRequest,
  Connection,
  Credential,
  Frame,
  NodeCopy,
  Outcome,
  Position,
  Request,
} from '#kernel/types'
import { createTwpServing } from '#protocol/serve'

/** Waits for an actual producer or consumer event. */
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Event observer is absent') }
  const promise = new Promise<T>(ready => { resolve = ready })
  return { promise, resolve }
}

/** Seeds root shadows, then opens the second owner through an accepted native mount. */
async function fixture(t: TestContext) {
  const id = `domain-reset:${randomUUID()}`
  const store = createMemoryStore({ domain: id })
  const password = randomUUID()
  let saved: Position | undefined
  let issued = 0
  const positionObservers = new Set<(position: Position) => void>()
  const instance = await createInstance({
    id,
    root: { kind: 'store', store },
    modules: [],
    blobs: createMemoryBlobStore(),
    provisioning: {
      writerEpoch: 1,
      domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      counter: {
        async load() { return saved },
        async save(position) {
          saved = position
          for (const observe of positionObservers) observe(position)
        },
        async freshEpoch(floor) { issued = Math.max(issued, floor) + 1; return issued },
      },
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password } },
    },
  })
  const serving = createTwpServing(instance)
  assert.ok(instance.setupCredential)
  const credential = instance.setupCredential
  const admin = await instance.openSession(credential)
  const delivery = drainSession(admin)
  t.after(async () => {
    serving.close()
    await instance.close()
    await delivery
  })
  const key = () => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() })
  const commit = (changes: readonly ChangeMember[]) => admin.commit({ opId: key(), changes }).outcome
  await commit([
    { op: 'put', node: { $path: '/stable', $type: 't.dir', value: 1 } },
    { op: 'put', node: { $path: '/data', $type: 't.dir' } },
    { op: 'put', node: { $path: '/data/active', $type: 't.dir' } },
    { op: 'put', node: { $path: '/data/active/item', $type: 't.dir', value: 100 } },
  ])
  await commit([{ op: 'patch', path: '/data', ops: { $set: { '#mount': { $type: 't.mount.memory', pattern: 'active' } } } }])
  await commit([{ op: 'put', node: { $path: '/data/active', $type: 't.dir' } }])
  await commit([{ op: 'put', node: { $path: '/data/active/item', $type: 't.dir', value: 10 } }])
  /** Observes the deployment counter when a genuine mutation reserves its position. */
  function observePosition(observer: (position: Position) => void) {
    positionObservers.add(observer)
    return () => positionObservers.delete(observer)
  }
  return { instance, serving, store, credential, admin, key, commit, password, observePosition }
}

/** Records only frames pulled from the genuine serving connection. */
async function connect(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  credential: Credential,
  beforeDelivery?: (frame: Frame) => Promise<void>,
) {
  const origin = '127.0.0.1'
  const opened = await f.serving.open({ t: 'hi' }, credential, origin)
  const attached = f.serving.attach(opened.id, credential, origin)
  const seen: Frame[] = []
  const sent: Request[] = []
  const terminated = deferred<KernelError>()
  const connection: Connection = {
    frames: {
      async *[Symbol.asyncIterator]() {
        for await (const frame of attached.frames) {
          await beforeDelivery?.(frame)
          seen.push(frame)
          yield frame
        }
      },
    },
    send(request: Request) {
      sent.push(request)
      f.serving.dispatch(opened.id, credential, origin, [request])
    },
  }
  const client = createTwpClient(connection, { close: attached.close, credential, onError: terminated.resolve })
  t.after(() => client.close())
  const welcome = await client.ready
  return { client, seen, sent, welcome, terminated: terminated.promise }
}

/** Observes durable intake rotation caused by an accepted declaration change. */
function nextIntake(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const previous = f.instance.writer.intake.epoch
  const changed = deferred<string>()
  const unsubscribe = f.instance.writer.stream.observe(event => {
    if (event.t === 'commit' && event.record.intake !== undefined && event.record.intake.epoch !== previous)
      changed.resolve(event.record.intake.epoch)
  })
  t.after(unsubscribe)
  return changed.promise
}

/** Requires the most recent actual snapshot for the selected subscription. */
function snapshot(seen: readonly Frame[], sub: string) {
  let found: Extract<Frame, { t: 'snap' }> | undefined
  for (const frame of seen) if (frame.t === 'snap' && frame.sub === sub) found = frame
  assert.ok(found)
  return found
}

/** Requires an ordinary projected copy, including its native identity. */
function node(copy: NodeCopy | undefined) {
  assert.ok(copy && 'node' in copy)
  return copy.node
}

/** Checks that fresh mutation completion follows its ordinary covering position. */
function assertCompletion(seen: readonly Frame[], req: string, outcome: Outcome) {
  const pos = outcome.pos
  assert.ok(pos)
  const done = seen.findIndex(frame => frame.t === 'done' && frame.req === req)
  const covered = seen.findIndex(frame => frame.t === 'pos' && frame.coverage !== true && comparePositions(frame.pos, pos) >= 0)
  assert.ok(covered >= 0 && covered < done)
  const completion = seen[done]
  assert.ok(completion.t === 'done')
  assert.deepEqual(completion.pos, pos)
}

describe('public native domain continuity', { timeout: 10_000 }, () => {
  it('keeps unrelated coverage alive while retired coverage restarts against the root shadow', async t => {
    const f = await fixture(t)
    const current = await connect(t, f, f.credential)
    const stable = current.client.sub({ node: '/stable' }, () => {})
    const refresh = deferred<KernelError | undefined>()
    let oldGeneration: number | undefined
    const affected = current.client.sub({ children: '/data/active' }, () => {
      const list = current.client.cache.list(affected.id)
      if (oldGeneration !== undefined && list?.phase === 'ready' && list.gen > oldGeneration) refresh.resolve(undefined)
    }, refresh.resolve)
    await Promise.all([stable.ready, affected.ready])
    const stableList = current.client.cache.list(stable.id)
    assert.ok(stableList)
    const affectedSnap = snapshot(current.seen, affected.id)
    oldGeneration = affectedSnap.gen
    const stableId = node(current.client.cache.at('/stable')).$id
    const mountedId = node(current.client.cache.at('/data/active/item')).$id
    assert.equal(node(current.client.cache.copy(mountedId)).value, 10)
    assert.ok(f.instance.writer.cache.get(stableId))
    assert.ok(f.instance.writer.cache.get(mountedId))
    const domainsBefore = { ...f.instance.writer.intake.domains }
    assert.equal(Object.keys(domainsBefore).length, 2)

    const rootRequest: CommitRequest = { opId: current.client.key(), changes: [{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }] }
    const rootPending = current.client.commit(rootRequest)
    const rootOutcome = await rootPending.outcome
    assertCompletion(current.seen, rootPending.id, rootOutcome)
    const lostRequest: CommitRequest = { opId: current.client.key(), changes: [{ op: 'patch', path: '/data/active/item', ops: { $inc: { value: 1 } } }] }
    const mountedPending = current.client.commit(lostRequest)
    assertCompletion(current.seen, mountedPending.id, await mountedPending.outcome)

    let retired: () => void = () => { throw new Error('Intake observer is absent') }
    const retirement = new Promise<void>(resolve => { retired = resolve })
    const intakeBefore = f.instance.writer.intake.epoch
    const unsubscribe = f.instance.writer.stream.observe(event => {
      if (event.t === 'commit' && event.record.intake !== undefined && event.record.intake.epoch !== intakeBefore) retired()
    })
    t.after(unsubscribe)
    const removal = await f.commit([{ op: 'patch', path: '/data', ops: { $unset: { '#mount': true } } }])
    assert.ok(removal.pos)
    await retirement

    const read = await current.client.read({ node: '/stable' })
    assert.equal(node(read.copies[0]).value, 2)
    assert.equal(await refresh.promise, undefined)
    assert.equal(current.client.failure(), undefined)
    assert.deepEqual(current.client.cache.list(stable.id), stableList)
    assert.ok(f.instance.writer.cache.get(stableId))
    assert.equal(node(current.client.cache.copy(stableId)).value, 2)
    const revealed = node(current.client.cache.at('/data/active/item'))
    assert.equal(revealed.value, 100)
    assert.notEqual(revealed.$id, mountedId)
    assert.equal(current.client.cache.copy(mountedId), undefined)
    assert.ok(snapshot(current.seen, affected.id).gen > affectedSnap.gen)
    assert.equal(current.seen.filter(frame => frame.t === 'welcome').length, 1)
    const domainsAfter = f.instance.writer.intake.domains
    assert.equal(Object.keys(domainsAfter).length, 1)
    assert.equal(domainsAfter[f.store.domain], domainsBefore[f.store.domain])

    const fresh = current.client.commit({ changes: [{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }] })
    assertCompletion(current.seen, fresh.id, await fresh.outcome)
    assert.equal(node(current.client.cache.copy(stableId)).value, 3)
    assert.deepEqual(await current.client.commit(rootRequest).outcome, rootOutcome)
    await assert.rejects(current.client.commit(lostRequest).outcome, error => error instanceof KernelError && error.code === 'UNKNOWN_OUTCOME')
    assert.equal(node(current.client.cache.copy(stableId)).value, 3)
    assert.equal(node(current.client.cache.at('/data/active/item')).value, 100)
  })

  it('preserves unrelated generations while a changed declaration installs a new memory owner', async t => {
    const f = await fixture(t)
    const current = await connect(t, f, f.credential)
    const stable = current.client.sub({ node: '/stable' }, () => {})
    const updated = deferred<KernelError | undefined>()
    let original: number | undefined
    const affected = current.client.sub({ children: '/data/active' }, () => {
      const list = current.client.cache.list(affected.id)
      if (original !== undefined && list?.phase === 'ready' && list.gen > original) updated.resolve(undefined)
    }, updated.resolve)
    await Promise.all([stable.ready, affected.ready])
    original = snapshot(current.seen, affected.id).gen
    const stableList = current.client.cache.list(stable.id)
    assert.ok(stableList)
    const oldId = node(current.client.cache.at('/data/active/item')).$id
    const rotation = nextIntake(t, f)
    await f.commit([{ op: 'patch', path: '/data', ops: { $set: { '#mount.pattern': 'replacement' } } }])
    await rotation
    assert.equal(node((await current.client.read({ node: '/stable' })).copies[0]).value, 1)
    assert.equal(await updated.promise, undefined)
    assert.deepEqual(current.client.cache.list(stable.id), stableList)
    assert.equal(node(current.client.cache.at('/data/active/item')).value, 100)
    assert.equal(current.client.cache.copy(oldId), undefined)

    await f.commit([{ op: 'put', node: { $path: '/data/replacement', $type: 't.dir' } }])
    await f.commit([{ op: 'put', node: { $path: '/data/replacement/item', $type: 't.dir', value: 20 } }])
    const replacement = current.client.sub({ children: '/data/replacement' }, () => {})
    await replacement.ready
    assert.equal(node(current.client.cache.at('/data/replacement/item')).value, 20)
    assert.equal(Object.keys(f.instance.writer.intake.domains).length, 2)
    assert.deepEqual(current.client.cache.list(stable.id), stableList)
    assert.equal(current.client.failure(), undefined)
    const fresh = current.client.commit({ changes: [{ op: 'patch', path: '/data/replacement/item', ops: { $inc: { value: 1 } } }] })
    assertCompletion(current.seen, fresh.id, await fresh.outcome)
    assert.equal(node(current.client.cache.at('/data/replacement/item')).value, 21)
  })

  it('keeps accepted pending keys unchanged when retirement overtakes a delayed ordinary delivery', async t => {
    const f = await fixture(t)
    const held = deferred<Extract<Frame, { t: 'pos' }>>()
    const release = deferred<void>()
    t.after(() => release.resolve())
    let pause = false
    const current = await connect(t, f, f.credential, async frame => {
      if (pause && frame.t === 'pos' && frame.coverage !== true) {
        pause = false
        held.resolve(frame)
        await release.promise
      }
    })
    const stable = current.client.sub({ node: '/stable' }, () => {})
    const affected = current.client.sub({ children: '/data/active' }, () => {})
    await Promise.all([stable.ready, affected.ready])
    const stableList = current.client.cache.list(stable.id)
    const initialEpoch = current.client.key().epoch
    pause = true
    const pending = current.client.commit({ changes: [{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }] })
    const covering = await held.promise
    assert.ok(covering.coverage !== true)
    assert.ok(covering.intake === undefined || covering.intake === initialEpoch)
    const sent = current.sent.find(request => request.t === 'commit' && request.req === pending.id)
    assert.ok(sent?.t === 'commit')
    assert.equal(sent.opId.epoch, initialEpoch)
    const rotation = nextIntake(t, f)
    await f.commit([{ op: 'patch', path: '/data', ops: { $unset: { '#mount': true } } }])
    const nextEpoch = await rotation
    assert.notEqual(nextEpoch, initialEpoch)
    assert.notEqual(covering.intake, nextEpoch)
    assert.equal(current.client.key().epoch, initialEpoch)

    release.resolve()
    const outcome = await pending.outcome
    assert.deepEqual(outcome.pos, covering.pos)
    assertCompletion(current.seen, pending.id, outcome)
    const read = await current.client.read({ node: '/stable' })
    assert.equal(node(read.copies[0]).value, 2)
    assert.deepEqual(current.client.cache.list(stable.id), stableList)
    const fresh = current.client.commit({ changes: [{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }] })
    const freshOutcome = await fresh.outcome
    const freshRequest = current.sent.find(request => request.t === 'commit' && request.req === fresh.id)
    assert.ok(freshRequest?.t === 'commit')
    assert.equal(freshRequest.opId.epoch, nextEpoch)
    assertCompletion(current.seen, fresh.id, freshOutcome)
    assert.deepEqual(await current.client.commit({ opId: sent.opId, changes: sent.changes, expect: sent.expect }).outcome, outcome)
    assert.equal(node(current.client.cache.at('/stable')).value, 3)
    assert.equal(current.seen.filter(frame => frame.t === 'welcome').length, 1)
  })

  it('still closes every subscription when the real caller credential is revoked', async t => {
    const f = await fixture(t)
    const credential = await f.instance.auth.login({ account: '/admin', password: f.password })
    const current = await connect(t, f, credential)
    const stable = current.client.sub({ node: '/stable' }, () => {})
    const affected = current.client.sub({ children: '/data/active' }, () => {})
    await Promise.all([stable.ready, affected.ready])
    const mutation = f.commit([{ op: 'patch', path: credentialPath(credential.token), ops: { $set: { revoked: true } } }])
    const error = await current.terminated
    assert.equal(error.code, 'UNAUTHENTICATED')
    assert.ok((await mutation).pos)
    assert.equal(current.client.cache.list(stable.id), undefined)
    assert.equal(current.client.cache.list(affected.id), undefined)
    assert.equal(current.client.cache.at('/stable'), undefined)
    assert.equal(current.client.cache.at('/data/active/item'), undefined)
  })

  it('announces a renewed mutation intake on an idle lane without inventing subscription coverage', async t => {
    const f = await fixture(t)
    const current = await connect(t, f, f.credential)
    const rotation = nextIntake(t, f)
    await f.commit([{ op: 'patch', path: '/data', ops: { $unset: { '#mount': true } } }])
    const epoch = await rotation
    assert.equal(node((await current.client.read({ node: '/stable' })).copies[0]).value, 1)
    assert.notEqual(epoch, current.welcome.intake)
    assert.equal(current.client.key().epoch, epoch)
    const announced = current.seen.find(frame => frame.t === 'pos' && frame.coverage !== true && frame.intake === epoch)
    assert.ok(announced?.t === 'pos' && announced.coverage !== true)
    assert.deepEqual(announced.changes, [])
    assert.deepEqual(current.client.cache.claims(), [])
    assert.equal(current.seen.filter(frame => frame.t === 'welcome').length, 1)

    const pending = current.client.commit({ changes: [{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }] })
    assertCompletion(current.seen, pending.id, await pending.outcome)
    assert.equal(node((await current.client.read({ node: '/stable' })).copies[0]).value, 2)
    assert.equal(current.client.failure(), undefined)
  })

  it('covers a watch dirtied while the renewed intake read waits for an admitted mutation', async t => {
    const release = deferred<void>()
    t.after(() => release.resolve())
    const f = await fixture(t)
    await f.commit([{ op: 'put', node: { $path: '/another', $type: 't.dir', value: 7 } }])
    const lane = await f.instance.openSession(f.credential)
    const welcome = await lane.frames.next()
    assert.ok(welcome.done === false && welcome.value.t === 'welcome')
    const stable = lane.sub({ node: '/stable' })
    const stableSnap = await lane.frames.next()
    assert.ok(stableSnap.done === false && stableSnap.value.t === 'snap')
    const before = stableSnap.value.copies[0]
    assert.ok('node' in before)
    const another = lane.sub({ node: '/another' })
    const anotherSnap = await lane.frames.next()
    assert.ok(anotherSnap.done === false && anotherSnap.value.t === 'snap')
    const anotherId = anotherSnap.value.list[0]
    const rotation = nextIntake(t, f)
    await f.commit([{ op: 'patch', path: '/data', ops: { $unset: { '#mount': true } } }])
    const epoch = await rotation

    const entered = deferred<void>()
    const held = f.instance.writer.read([f.store.domain], async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const reserved = deferred<Position>()
    const unsubscribe = f.observePosition(reserved.resolve)
    t.after(unsubscribe)
    const late = f.commit([{ op: 'patch', path: '/stable', ops: { $inc: { value: 1 } } }])
    const assigned = await reserved.promise
    unsubscribe()
    const next = lane.frames.next()
    release.resolve()
    await held
    const accepted = await late
    const covering = await next

    assert.ok(covering.done === false && covering.value.t === 'pos' && covering.value.coverage !== true)
    assert.deepEqual(accepted.pos, assigned)
    assert.ok(comparePositions(covering.value.pos, assigned) >= 0)
    assert.equal(covering.value.intake, epoch)
    const changed = covering.value.changes.find(change => (change.op === 'patch' && change.id === before.node.$id)
      || (change.op === 'put' && node(change.copy).$id === before.node.$id))
    assert.ok(changed)
    if (changed.op === 'patch') {
      assert.equal(changed.base, before.ver)
      assert.equal(applyDelta(before.node, changed.delta).value, 2)
    } else {
      assert.ok(changed.op === 'put')
      assert.equal(node(changed.copy).value, 2)
    }

    const acceptedAnother = await f.commit([{ op: 'patch', path: '/another', ops: { $inc: { value: 1 } } }])
    const subsequent = await lane.frames.next()
    assert.ok(subsequent.done === false && subsequent.value.t === 'pos' && subsequent.value.coverage !== true)
    assert.deepEqual(subsequent.value.pos, acceptedAnother.pos)
    assert.ok(subsequent.value.changes.some(change => change.op === 'patch' && change.id === anotherId))
    for (const frame of [covering.value, subsequent.value])
      for (const change of frame.changes)
        if (change.op === 'list' && change.sub === stable) assert.equal(change.gen, stableSnap.value.gen)
        else if (change.op === 'list' && change.sub === another) assert.equal(change.gen, anotherSnap.value.gen)
  })
})
