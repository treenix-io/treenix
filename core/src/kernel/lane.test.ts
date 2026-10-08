import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import { createNodeLane, type NodeLaneFrame } from '#kernel/lane'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import { applyDelta } from '#kernel/update-ops'
import { R, type Gate, type ModuleManifest, type NodeCopy, type OpId, type Position } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
async function setup(gates: readonly Gate[] = []) {
  const root = createMemoryStore({ domain: 'lane' })
  let saved: Position | undefined, sequence = 0
  const instance = await createInstanceFoundation({ id: 'lane', root, writerEpoch: 1,
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    domains: [{ store: root, epoch: 'lane1', persistent: true }], budget: scanBudget,
    firstAdmin: { path: '/admin', name: 'admin', password: 'lane-password' }, initialCredential: { ttlMs: 60_000 }, gates })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  const admission = await instance.auth.openCredential(instance.setupCredential)
  const lane = createNodeLane(instance.nodeLaneOptions(admission))
  const key = (): OpId => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++sequence) })
  async function frame(): Promise<NodeLaneFrame> {
    const result = await lane.frames.next(); assert.ok(result.done === false); return result.value
  }
  async function seed() { await admin.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/item', $type: 't.dir', value: 1 } }] }) }
  return { instance, root, admin, admission, lane, key, frame, seed, close() { lane.close(); instance.auth.close() } }
}
function node(copy: NodeCopy) { assert.ok('node' in copy); return copy.node }
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('native node lane', { timeout: 15_000 }, () => {
  it('delivers the real welcome, snapshot and one projected patch', async t => {
    const f = await setup(); t.after(f.close); await f.seed()
    const welcome = await f.frame(); assert.equal(welcome.t, 'welcome')
    if (welcome.t === 'welcome') assert.equal(welcome.intake, f.instance.writer.intake.epoch)
    const sub = f.lane.sub({ node: '/item' }), snap = await f.frame()
    assert.equal(snap.t, 'snap'); assert.ok(snap.t === 'snap'); assert.equal(snap.sub, sub)
    assert.equal(node(snap.copies[0]).value, 1)
    const accepted = await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 2 } } }] })
    const changed = await f.frame(); assert.ok(changed.t === 'pos'); assert.equal(changed.coverage, undefined)
    assert.deepEqual(changed.pos, accepted.pos)
    const patch = changed.changes.find(change => change.op === 'patch'); assert.ok(patch?.op === 'patch')
    assert.equal(patch.base, snap.copies[0].ver)
    assert.equal(applyDelta(node(snap.copies[0]), patch.delta).value, 2)
  })

  it('merges several pending writes into one current put and one position', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    f.lane.sub({ node: '/item' }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 2 } } }] })
    const latest = await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 3 } } }] })
    const changed = await f.frame(); assert.ok(changed.t === 'pos'); assert.deepEqual(changed.pos, latest.pos)
    assert.equal(changed.changes.length, 1); assert.ok(changed.changes[0].op === 'put')
    assert.equal(node(changed.changes[0].copy).value, 3)
  })

  it('flushes an existing copy before a second subscription snapshot', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    f.lane.sub({ node: '/item' }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    const accepted = await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 2 } } }] })
    const second = f.lane.sub({ node: '/item' })
    const changed = await f.frame(); assert.ok(changed.t === 'pos'); assert.deepEqual(changed.pos, accepted.pos)
    const patch = changed.changes.find(change => change.op === 'patch'); assert.ok(patch?.op === 'patch')
    assert.equal(patch.base, snap.copies[0].ver)
    const next = await f.frame(); assert.ok(next.t === 'snap'); assert.equal(next.sub, second)
    assert.deepEqual(next.at, [changed.pos]); assert.equal(next.copies.length, 0)
    assert.deepEqual(next.list, snap.list)
  })

  it('unsubscribes immediately at the delivered watermark and preserves other coverage', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    const first = f.lane.sub({ node: '/item' }), snap = await f.frame(); assert.ok(snap.t === 'snap')
    const second = f.lane.sub({ node: '/item' }), next = await f.frame(); assert.ok(next.t === 'snap')
    const before = f.instance.writer.stream.cursor().pos
    f.lane.unsub(first)
    const preserved = await f.frame(); assert.ok(preserved.t === 'pos' && preserved.coverage === true)
    assert.deepEqual(preserved.pos, snap.at[0]); assert.equal(preserved.changes.some(change => change.op === 'del'), false)
    f.lane.unsub(second)
    const removed = await f.frame(); assert.ok(removed.t === 'pos' && removed.coverage === true)
    assert.deepEqual(removed.changes.find(change => change.op === 'del'), { op: 'del', id: snap.list[0] })
    assert.deepEqual(f.instance.writer.stream.cursor().pos, before)
  })

  it('delivers a covering position before done and settles the original Pending', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    f.lane.sub({ node: '/item' }); await f.frame()
    const pending = f.lane.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 4 } } }] })
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    const done = await f.frame(); assert.ok(done.t === 'done'); assert.equal(done.req, pending.id)
    assert.deepEqual(done.pos, changed.pos); assert.deepEqual(await pending.outcome, { pos: changed.pos })
    const chunks: unknown[] = []; for await (const chunk of pending.chunks) chunks.push(chunk)
    assert.deepEqual(chunks, [])
  })

  it('covers a decision-only commit and preserves wire request correlation', async t => {
    const f = await setup(); t.after(f.close); await f.frame()
    f.lane.accept({ t: 'commit', req: 'client-key', changes: [], opId: f.key() })
    const changed = await f.frame(); assert.ok(changed.t === 'pos'); assert.deepEqual(changed.changes, [])
    const done = await f.frame(); assert.ok(done.t === 'done'); assert.equal(done.req, 'client-key'); assert.deepEqual(done.pos, changed.pos)
    f.lane.accept({ t: 'read', req: 'read-key', selector: { node: '/admin' } })
    const read = await f.frame(); assert.ok(read.t === 'done'); assert.equal(read.req, 'read-key'); assert.ok(read.value)
  })

  it('uses a put after ACL changes and removes a newly hidden node', async t => {
    const f = await setup(); t.after(f.close)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/public', $type: 't.dir', value: 1,
      $acl: [{ subject: { group: 'public' }, grant: R }] } }] })
    const anonymous = createNodeLane(f.instance.nodeLaneOptions(await f.instance.auth.openCredential()))
    t.after(() => anonymous.close()); await anonymous.frames.next(); anonymous.sub({ node: '/public' })
    const initial = await anonymous.frames.next(); assert.ok(initial.done === false && initial.value.t === 'snap')
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/public', ops: { $set: { $acl: [] } } }] })
    const changed = await anonymous.frames.next(); assert.ok(changed.done === false && changed.value.t === 'pos')
    assert.ok(changed.value.changes.some(change => change.op === 'del'))
    assert.ok(changed.value.changes.some(change => change.op === 'list'))
  })

  it('reports hidden and absent initial subscriptions with the same NOT_FOUND', async t => {
    const f = await setup(); t.after(f.close); await f.seed()
    const anonymous = createNodeLane(f.instance.nodeLaneOptions(await f.instance.auth.openCredential()))
    t.after(() => anonymous.close()); await anonymous.frames.next()
    anonymous.sub({ node: '/item' }); const hidden = await anonymous.frames.next(); assert.ok(hidden.done === false && hidden.value.t === 'end')
    anonymous.sub({ node: '/absent' }); const absent = await anonymous.frames.next(); assert.ok(absent.done === false && absent.value.t === 'end')
    assert.equal(hidden.value.error.code, 'NOT_FOUND'); assert.equal(absent.value.error.code, 'NOT_FOUND')
  })

  it('closes outstanding delivery on actual actor revocation', async t => {
    const f = await setup(); t.after(f.close); await f.frame()
    const next = f.lane.frames.next()
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/admin', ops: { $set: { status: 'blocked' } } }] })
    await assert.rejects(next, code('UNAUTHENTICATED'))
    assert.throws(() => f.lane.touch(), code('UNAUTHENTICATED'))
  })

  it('executes the real post action and orders its patch before the correlated done', async t => {
    const f = await setup(); t.after(f.close)
    const manifest: ModuleManifest = { id: 'lane-test', types: [{ name: 'lane.document', module: 'lane-test',
      version: 0, security: 'ordinary', schema: {}, actionsOnly: true, actions: {
        increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } },
      } }], security: [], open: [] }
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/sys/types/lane.document', $type: 't.type',
      name: 'lane.document', module: 'lane-test', security: 'ordinary' } }] })
    f.instance.registry.publish(manifest)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/document', $type: 'lane.document', count: 0 } }] })
    await f.frame(); f.lane.sub({ node: '/document' }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    f.lane.accept({ t: 'act', req: 'increment', path: '/document', action: 'increment', args: {}, opId: f.key() })
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    const patch = changed.changes.find(change => change.op === 'patch'); assert.ok(patch?.op === 'patch')
    assert.equal(applyDelta(node(snap.copies[0]), patch.delta).count, 1)
    const done = await f.frame(); assert.ok(done.t === 'done'); assert.equal(done.req, 'increment'); assert.deepEqual(done.pos, changed.pos)
  })

  it('cancels one gated request while another lane request succeeds', async t => {
    const entered = signal(), release = signal()
    let blocking = false
    const f = await setup([async operation => {
      if (operation.kind === 'commit' && blocking) { entered.resolve(); await release.promise }
      return 'pass'
    }]); t.after(f.close); await f.seed(); await f.frame()
    blocking = true
    const pending = f.lane.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 2 } } }] })
    await entered.promise; f.lane.cancel(pending.id)
    const denied = await f.frame(); assert.ok(denied.t === 'fail'); assert.equal(denied.req, pending.id); assert.equal(denied.error.code, 'CANCELLED')
    await assert.rejects(pending.outcome, code('CANCELLED'))
    blocking = false; release.resolve()
    assert.equal((await f.lane.read({ node: '/item' })).copies.length, 1)
    assert.equal((await f.instance.source.node('/item'))?.value, 1)
  })

  it('ends only subscriptions covering a grown image that exceeds the coverage budget', async t => {
    const f = await setup(); t.after(f.close)
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/sys/limits', $type: 't.limits', laneCoverageBytes: 1800 } },
      { op: 'put', node: { $path: '/small', $type: 't.dir', value: 'small' } },
      { op: 'put', node: { $path: '/growing', $type: 't.dir', value: 'small' } },
    ] })
    await f.frame(); const small = f.lane.sub({ node: '/small' }); await f.frame()
    const grown = f.lane.sub({ node: '/growing' }); await f.frame()
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/growing', ops: { $set: { value: 'x'.repeat(2000) } } }] })
    const end = await f.frame(); assert.ok(end.t === 'end'); assert.equal(end.sub, grown); assert.equal(end.error.code, 'BUDGET')
    const removed = await f.frame(); assert.ok(removed.t === 'pos' && removed.coverage === true)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/small', ops: { $set: { value: 'still alive' } } }] })
    const changed = await f.frame(); assert.ok(changed.t === 'pos'); assert.ok(changed.changes.some(change => change.op === 'patch'))
    assert.equal(end.sub === small, false)
  })

  it('resets projection generations after actual module publication without repeating an ordinary position', async t => {
    const f = await setup(); t.after(f.close)
    const manifest: ModuleManifest = { id: 'lane-rules', types: [{ name: 'lane.rules', module: 'lane-rules',
      version: 0, security: 'ordinary', schema: {}, actions: {} }], security: [], open: [] }
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/sys/types/lane.rules', $type: 't.type',
      name: 'lane.rules', module: 'lane-rules', security: 'ordinary' } }] })
    f.instance.registry.publish(manifest)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/rules', $type: 'lane.rules', value: 1 } }] })
    await f.frame(); const sub = f.lane.sub({ node: '/rules' }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    f.instance.registry.publish({ ...manifest, security: [{ type: 'lane.rules', context: 'acl', handler: () => R }] })
    const reset = await f.frame(); assert.ok(reset.t === 'reset'); assert.equal(reset.sub, sub); assert.ok(reset.gen > snap.gen)
    const current = await f.frame(); assert.ok(current.t === 'snap'); assert.equal(current.gen, reset.gen)
    assert.deepEqual(current.at, snap.at); assert.equal(current.copies.length, 1); assert.equal(current.copies[0].ver === snap.copies[0].ver, false)
  })

  it('enforces the actual heartbeat deadline and releases pending delivery without sleeps', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
    const f = await setup(); t.after(f.close); await f.frame()
    t.mock.timers.tick(20_000); f.lane.touch()
    t.mock.timers.tick(20_000); assert.equal(f.admission.signal.aborted, false)
    const pending = f.lane.frames.next()
    t.mock.timers.tick(10_000)
    await assert.rejects(pending, code('UNAVAILABLE')); assert.equal(f.admission.signal.aborted, true)
  })

  it('preserves canonical success when cancellation follows durable Store acceptance', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    const accepted = signal(), release = signal(), storeCommit = f.root.commit
    t.mock.method(f.root, 'commit', async (...args: Parameters<typeof storeCommit>) => {
      await storeCommit(...args); accepted.resolve(); await release.promise
    })
    const pending = f.lane.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 5 } } }] })
    await accepted.promise; f.lane.cancel(pending.id); release.resolve()
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    const done = await f.frame(); assert.ok(done.t === 'done'); assert.deepEqual(await pending.outcome, { pos: done.pos })
    assert.equal((await f.instance.source.node('/item'))?.value, 5)
  })

  it('retains the accepted outcome even if the lane closes before publication returns', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    const accepted = signal(), release = signal(), storeCommit = f.root.commit
    t.mock.method(f.root, 'commit', async (...args: Parameters<typeof storeCommit>) => {
      await storeCommit(...args); accepted.resolve(); await release.promise
    })
    const pending = f.lane.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 6 } } }] })
    await accepted.promise; f.lane.close(); release.resolve()
    const outcome = await pending.outcome; assert.ok(outcome.pos)
    assert.equal((await f.instance.source.node('/item'))?.value, 6)
    assert.equal((await f.lane.frames.next()).done, true)
  })

  it('suppresses the old asynchronous gate after reusing an unsubscribed wire identifier', async t => {
    const entered = signal(), release = signal()
    let first = true
    const f = await setup([async operation => {
      if (operation.kind === 'sub' && first) { first = false; entered.resolve(); await release.promise }
      return 'pass'
    }]); t.after(f.close); await f.seed(); await f.frame()
    f.lane.accept({ t: 'sub', sub: 'same', selector: { node: '/item' } }); await entered.promise
    f.lane.unsub('same'); f.lane.accept({ t: 'sub', sub: 'same', selector: { node: '/item' } })
    const snap = await f.frame(); assert.ok(snap.t === 'snap'); assert.equal(snap.sub, 'same')
    release.resolve()
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/item', ops: { $set: { value: 7 } } }] })
    const changed = await f.frame(); assert.ok(changed.t === 'pos'); assert.equal(changed.changes.length, 1)
    assert.ok(changed.changes[0].op === 'patch'); assert.equal(changed.changes[0].base, snap.copies[0].ver)
  })

  it('coalesces deletion and recreation into the final identity and list', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    const sub = f.lane.sub({ node: '/item' }), snap = await f.frame(); assert.ok(snap.t === 'snap')
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'remove', path: '/item' }] })
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/item', $type: 't.dir', value: 8 } }] })
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    const put = changed.changes.find(change => change.op === 'put'); assert.ok(put?.op === 'put')
    assert.equal(node(put.copy).value, 8); assert.notEqual(node(put.copy).$id, snap.list[0])
    assert.ok(changed.changes.some(change => change.op === 'del' && change.id === snap.list[0]))
    assert.ok(changed.changes.some(change => change.op === 'list' && change.sub === sub))
  })

  it('transfers shared coverage atomically when a node moves between live subscription paths', async t => {
    const f = await setup(); t.after(f.close)
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/item', $type: 't.dir', value: 1 } },
      { op: 'put', node: { $path: '/other', $type: 't.dir', value: 2 } },
    ] })
    await f.frame(); f.lane.sub({ node: '/item' }); const first = await f.frame(); assert.ok(first.t === 'snap')
    f.lane.sub({ node: '/other' }); await f.frame()
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'remove', path: '/other' }] }); await f.frame()
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'move', from: '/item', to: '/other' }] })
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    const put = changed.changes.find(change => change.op === 'put'); assert.ok(put?.op === 'put')
    assert.equal(node(put.copy).$id, first.list[0]); assert.equal(node(put.copy).$path, '/other')
    assert.equal(changed.changes.some(change => change.op === 'del' && change.id === first.list[0]), false)
  })

  it('uses the current full copy for a real external reconciliation record', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    f.lane.sub({ node: '/item' }); await f.frame()
    const before = await f.instance.source.node('/item'); assert.ok(before)
    await f.instance.writer.commit(f.root, [], pos => {
      const after = { ...before, $pos: pos, value: 9 }
      return { writes: [{ path: '/item', node: after }], record: { pos, kind: 'reconcile', executor: 'external:lane', caller: 'external:lane',
        entries: [{ id: before.$id, path: '/item', change: { t: 'reconcile', after } }] } }
    })
    const changed = await f.frame(); assert.ok(changed.t === 'pos'); assert.equal(changed.changes.length, 1)
    assert.ok(changed.changes[0].op === 'put'); assert.equal(node(changed.changes[0].copy).value, 9)
  })

  it('bounds unfinished direct reads and closes on excess request intake', async t => {
    const entered = signal(), release = signal()
    const f = await setup([async operation => { if (operation.kind === 'read') { entered.resolve(); await release.promise }; return 'pass' }])
    t.after(f.close)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/sys/limits', $type: 't.limits', laneRequests: 1 } }] })
    await f.frame(); const pending = f.lane.read({ node: '/admin' }); await entered.promise
    assert.throws(() => f.lane.read({ node: '/admin' }), code('BUDGET'))
    await assert.rejects(pending, code('BUDGET')); release.resolve()
    assert.equal(f.admission.signal.aborted, true)
  })

  it('releases all resources when the consumer returns', async t => {
    const f = await setup(); t.after(f.close); await f.seed(); await f.frame()
    f.lane.sub({ node: '/item' }); await f.frame()
    assert.deepEqual(await f.lane.frames.return?.(), { done: true, value: undefined })
    assert.equal(f.admission.signal.aborted, true)
    assert.equal((await f.lane.frames.next()).done, true)
  })
})
