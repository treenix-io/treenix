import type { PositionCounter } from '#kernel/types'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { requestHash, type MutationIdentity } from '#kernel/idempotency'
import { compactJournal } from '#kernel/journal'
import { scanBudget, storedNode } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import type { Actor, OpId, Position, Store } from '#kernel/types'
import { createWriter, type PreparedMutation } from '#kernel/writer'

const actor: Actor = { principal: 'u:one', claims: ['u:one', 'group:editors'], scope: ['/items'] }
const errorCode = (code: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === code
const noExecution = async () => { throw new Error('A replay executed its handler') }
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function counter(): PositionCounter {
  let saved: Position | undefined, epoch = 0
  return {
    async load() { return saved },
    async save(position) { saved = { ...position } },
    async freshEpoch(floor) { epoch = Math.max(epoch, floor) + 1; return epoch },
  }
}
async function fixture() {
  const failure = new Error('Store refused publication')
  let fail = false, now = 10_000
  const root = createMemoryStore({ domain: 'root', beforeRecord() { if (fail) throw failure } })
  const data = createMemoryStore({ domain: 'data' }), saved = counter()
  const open = (target = data, dataEpoch = 'data:1', writerEpoch = 1) => createWriter({
    instance: 'test', root, counter: saved, writerEpoch, budget: scanBudget,
    domains: [{ store: root, epoch: 'root:1', persistent: true }, { store: target, epoch: dataEpoch, persistent: false }],
    intake: { now: () => now, limits: { opIdWindowMs: 1000, clockToleranceMs: 100 } },
  })
  const writer = await open()
  const identity = (nonce = 'one', changes: Partial<MutationIdentity> = {}): MutationIdentity => ({
    actor, opId: { epoch: writer.intake.epoch, time: now, nonce },
    request: { t: 'commit', changes: [{ t: 'put', path: '/items/one', data: { value: 1 } }] }, ...changes,
  })
  return { writer, root, data, open, identity, failure, fail(value: boolean) { fail = value }, time(value: number) { now = value } }
}
function prepared(pos: Position, caller = actor.principal, path?: string, value: unknown = { accepted: true }): PreparedMutation {
  const node = path === undefined ? undefined : { ...storedNode(path, { value: 1 }), $pos: pos }
  return { writes: node === undefined ? [] : [{ path: node.$path, node }], value,
    record: { pos, kind: 'commit', caller, executor: caller, entries: node === undefined ? [] : [
      { id: node.$id, path: node.$path, change: { t: 'create', after: node } },
    ] } }
}
const journal = async (store: Store) => (await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items
const decision = async (store: Store, opId: OpId, caller = actor.principal) =>
  (await store.scan({ range: { decision: { caller, opId } }, budget: scanBudget() })).items

describe('journal-backed mutation identity', { timeout: 10_000 }, () => {
  it('hashes the complete request and original actor deterministically', () => {
    const first = requestHash({ a: 1, b: { x: 2, y: 3 } }, actor)
    assert.equal(requestHash({ b: { y: 3, x: 2 }, a: 1 }, actor), first)
    assert.notEqual(requestHash({ a: 2, b: { x: 2, y: 3 } }, actor), first)
    assert.notEqual(requestHash({ a: 1, b: { x: 2, y: 3 } }, { ...actor, scope: ['/other'] }), first)
    assert.notEqual(requestHash({ a: 1, b: { x: 2, y: 3 } }, { ...actor, claims: ['u:one'] }), first)
  })

  it('commits data and its decision together and replays without executing', async () => {
    const { writer, root, identity } = await fixture(), input = identity()
    const outcome = await writer.mutate(input, span => span.finish(root, [], pos => prepared(pos, actor.principal, '/items/one')))
    const rows = await journal(root), record = rows.at(-1)!
    assert.deepEqual(record.decision, { opId: input.opId, requestHash: requestHash(input.request, actor), outcome })
    assert.deepEqual((await root.scan({ range: { node: '/items/one' }, budget: scanBudget() })).items[0].$pos, outcome.pos)
    assert.deepEqual(await writer.mutate(input, noExecution), outcome)
    assert.deepEqual(await journal(root), rows)
    assert.equal(record.entries.length, 1)
  })

  it('owns the returned outcome so callers cannot change a durable replay', async () => {
    const { writer, root, identity } = await fixture(), input = identity(), result = { nested: [1, 2] }
    const first = await writer.mutate(input, span => span.finish(root, [], pos => prepared(pos, actor.principal, undefined, result)))
    result.nested.push(3)
    assert.ok(Reflect.set(first.pos!, 'seq', 999))
    const replay = await writer.mutate(input, noExecution)
    assert.deepEqual(replay.value, { nested: [1, 2] })
    assert.notEqual(replay.pos!.seq, 999)
  })

  it('probes accepted decisions before loading a removed target and does not admit a read key', async () => {
    const f = await fixture(), input = f.identity(), rows = await journal(f.root)
    assert.equal(await f.writer.replay(f.identity('missing', { opId: { epoch: 'unknown', time: 0, nonce: 'read' } })), undefined)
    assert.deepEqual(await journal(f.root), rows)
    const outcome = await f.writer.mutate(input, span => span.finish(f.root, [], pos => prepared(pos)))
    assert.deepEqual(await f.writer.replay(input), outcome)
    await assert.rejects(() => f.writer.replay({ ...input, request: 'changed' }), errorCode('KEY_REUSED'))
    f.time(11_001)
    await assert.rejects(() => f.writer.replay(input), errorCode('EXPIRED'))
  })

  it('coalesces a decision probe with an in-flight effect', async () => {
    const f = await fixture(), input = f.identity(), entered = signal(), release = signal()
    const pending = f.writer.mutate(input, async span => {
      entered.resolve(); await release.promise
      await span.finish(f.root, [], pos => prepared(pos))
    })
    await entered.promise
    const replay = f.writer.replay(input)
    await assert.rejects(() => f.writer.replay({ ...input, request: 'changed' }), errorCode('KEY_REUSED'))
    release.resolve()
    assert.deepEqual(await replay, await pending)
    assert.equal((await decision(f.root, input.opId)).length, 1)
  })

  it('refuses reuse with a different request, claims or scope without returning the outcome', async () => {
    const { writer, root, identity } = await fixture(), input = identity()
    await writer.mutate(input, span => span.finish(root, [], pos => prepared(pos)))
    const rows = await journal(root)
    for (const changed of [{ ...input, request: { t: 'commit', changes: [] } },
      { ...input, actor: { ...actor, claims: ['u:one'] } }, { ...input, actor: { ...actor, scope: ['/other'] } }]) {
      await assert.rejects(() => writer.mutate(changed, noExecution), errorCode('KEY_REUSED'))
    }
    assert.deepEqual(await journal(root), rows)
  })

  it('keeps keys of different callers independent', async () => {
    const { writer, root, identity } = await fixture(), input = identity()
    const other: MutationIdentity = { ...input, actor: { principal: 'u:two', claims: ['u:two'] } }
    const first = await writer.mutate(input, span => span.finish(root, [], pos => prepared(pos)))
    const second = await writer.mutate(other, span => span.finish(root, [], pos => prepared(pos, other.actor.principal)))
    assert.notDeepEqual(second.pos, first.pos)
    assert.equal((await decision(root, input.opId, other.actor.principal)).length, 1)
    assert.deepEqual(await writer.mutate(input, noExecution), first)
    assert.deepEqual(await writer.mutate(other, noExecution), second)
  })

  it('waits for the first concurrent attempt and executes the key once', async () => {
    const { writer, root, identity } = await fixture(), input = identity(), entered = signal(), release = signal()
    let calls = 0
    const first = writer.mutate(input, async span => {
      calls++; entered.resolve(); await release.promise
      return span.finish(root, [], pos => prepared(pos))
    })
    await entered.promise
    const second = writer.mutate(input, noExecution)
    const reused = assert.rejects(() => writer.mutate({ ...input, request: 'changed' }, noExecution), errorCode('KEY_REUSED'))
    release.resolve()
    const outcomes = await Promise.all([first, second])
    await reused
    assert.deepEqual(outcomes[0], outcomes[1])
    assert.equal(calls, 1)
    assert.equal((await decision(root, input.opId)).length, 1)
  })

  it('shares a failed attempt with concurrent duplicates and permits a later retry', async () => {
    const { writer, root, identity, failure } = await fixture(), input = identity(), entered = signal(), release = signal()
    const first = writer.mutate(input, async () => { entered.resolve(); await release.promise; throw failure })
    const refusal = assert.rejects(first, (error: unknown) => error === failure)
    await entered.promise
    const duplicate = assert.rejects(writer.mutate(input, noExecution), (error: unknown) => error === failure)
    await assert.rejects(() => writer.mutate({ ...input, actor: { ...actor, scope: ['/other'] } }, noExecution), errorCode('KEY_REUSED'))
    release.resolve()
    await Promise.all([refusal, duplicate])
    assert.deepEqual(await decision(root, input.opId), [])
    const retried = await writer.mutate(input, span => span.finish(root, [], pos => prepared(pos)))
    assert.deepEqual(await writer.mutate(input, noExecution), retried)
  })

  it('leaves neither data nor a decision when Store publication fails', async () => {
    const f = await fixture(), input = f.identity(), before = await journal(f.root)
    f.fail(true)
    await assert.rejects(() => f.writer.mutate(input, span => span.finish(f.root, [], pos => prepared(pos, actor.principal, '/items/one'))),
      (error: unknown) => error === f.failure)
    assert.deepEqual(await journal(f.root), before)
    assert.deepEqual(await decision(f.root, input.opId), [])
    assert.deepEqual((await f.root.scan({ range: { node: '/items/one' }, budget: scanBudget() })).items, [])
    f.fail(false)
    const outcome = await f.writer.mutate(input, span => span.finish(f.root, [], pos => prepared(pos, actor.principal, '/items/one')))
    assert.deepEqual(await f.writer.mutate(input, noExecution), outcome)
  })

  it('does not manufacture an outcome when a handler catches a failed final commit', async () => {
    const f = await fixture(), input = f.identity()
    f.fail(true)
    await assert.rejects(() => f.writer.mutate(input, async span => {
      await assert.rejects(span.finish(f.root, [], pos => prepared(pos)), (error: unknown) => error === f.failure)
      return 'caught'
    }), errorCode('INVALID'))
    assert.deepEqual(await decision(f.root, input.opId), [])
  })

  it('replays the durable result after the original response was lost', async () => {
    const { writer, root, identity } = await fixture(), input = identity(), lost = new Error('Response lost')
    await assert.rejects(() => writer.mutate(input, async span => {
      await span.finish(root, [], pos => prepared(pos)); throw lost
    }), (error: unknown) => error === lost)
    const [record] = await decision(root, input.opId)
    assert.deepEqual(await writer.mutate(input, noExecution), record.decision!.outcome)
  })

  it('returns a committed outcome to a waiting duplicate when the first response fails', async () => {
    const { writer, root, identity } = await fixture(), input = identity(), committed = signal(), release = signal()
    const lost = new Error('Response lost')
    const first = writer.mutate(input, async span => {
      await span.finish(root, [], pos => prepared(pos)); committed.resolve(); await release.promise; throw lost
    })
    const refusal = assert.rejects(first, (error: unknown) => error === lost)
    await committed.promise
    const duplicate = writer.mutate(input, noExecution)
    release.resolve()
    await refusal
    const [record] = await decision(root, input.opId)
    assert.deepEqual(await duplicate, record.decision!.outcome)
  })

  it('records a successful action without writes in its target domain', async () => {
    const { writer, root, data, identity } = await fixture(), input = identity(), before = await journal(root)
    const outcome = await writer.mutate(input, span => span.finish(data, [], pos => prepared(pos)))
    const [record] = await decision(data, input.opId)
    assert.deepEqual(record.entries, [])
    assert.deepEqual(record.decision!.outcome, outcome)
    assert.deepEqual(await journal(root), before)
    assert.deepEqual((await data.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
  })

  it('records a stream start and final outcome across domains and waits for concurrent duplicates', async () => {
    const { writer, root, data, identity } = await fixture()
    const input = identity('stream', { stream: { executor: 'n:service', target: 'target-id' } })
    const entered = signal(), release = signal()
    const first = writer.mutate(input, async span => {
      await span.step(root, [], pos => ({ ...prepared(pos), record: { ...prepared(pos).record, executor: 'n:service' } }))
      entered.resolve(); await release.promise
      return span.finish(data, [], pos => ({ ...prepared(pos), record: { ...prepared(pos).record, executor: 'n:service' } }))
    })
    await entered.promise
    const [start] = await decision(root, input.opId)
    assert.equal(start.decision!.outcome, undefined)
    assert.deepEqual(start.decision!.stream, input.stream)
    const duplicate = writer.mutate(input, noExecution)
    release.resolve()
    const [outcome, replay] = await Promise.all([first, duplicate])
    assert.deepEqual(replay, outcome)
    assert.deepEqual((await decision(data, input.opId))[0].decision!.outcome, outcome)
    assert.deepEqual(await writer.mutate(input, noExecution), outcome)
  })

  it('returns an unknown outcome for a stream that started without finishing', async () => {
    const { writer, root, identity } = await fixture(), input = identity('stream', { stream: { executor: actor.principal, target: 'target-id' } })
    const lost = new Error('Stream interrupted')
    await assert.rejects(() => writer.mutate(input, async span => { await span.step(root, [], pos => prepared(pos)); throw lost }),
      (error: unknown) => error === lost)
    await assert.rejects(() => writer.mutate(input, noExecution), errorCode('UNKNOWN_OUTCOME'))
    await assert.rejects(() => writer.mutate({ ...input, request: 'changed' }, noExecution), errorCode('KEY_REUSED'))
  })

  it('keeps intake identity and decisions when only process caches are lost', async () => {
    const { writer, root, data, identity, open } = await fixture(), input = identity()
    const outcome = await writer.mutate(input, span => span.finish(data, [], pos => prepared(pos)))
    const restarted = await open(data, 'data:1', 2)
    assert.equal(restarted.intake.epoch, writer.intake.epoch)
    assert.deepEqual(await restarted.mutate(input, noExecution), outcome)
    assert.equal((await journal(root)).at(-1)!.intake!.epoch, restarted.intake.epoch)
  })

  it('opens a fresh intake after domain loss while replaying surviving old decisions', async () => {
    const { writer, root, data, identity, open } = await fixture(), lost = identity('lost'), surviving = identity('surviving')
    await writer.mutate(lost, span => span.finish(data, [], pos => prepared(pos)))
    const outcome = await writer.mutate(surviving, span => span.finish(root, [], pos => prepared(pos)))
    const fresh = createMemoryStore({ domain: 'data' }), restarted = await open(fresh, 'data:2', 2)
    assert.notEqual(restarted.intake.epoch, writer.intake.epoch)
    await assert.rejects(() => restarted.mutate(lost, noExecution), errorCode('UNKNOWN_OUTCOME'))
    assert.deepEqual(await restarted.mutate(surviving, noExecution), outcome)
    const newInput = { ...lost, opId: { ...lost.opId, epoch: restarted.intake.epoch } }
    await restarted.mutate(newInput, span => span.finish(fresh, [], pos => prepared(pos)))
    assert.equal((await decision(fresh, newInput.opId)).length, 1)
  })

  it('durably opens a never-used intake before admitting requests after decision loss', async () => {
    const { writer, root, identity } = await fixture(), before = identity()
    const originalEpoch = writer.intake.epoch
    await writer.refreshIntake(true)
    const nextEpoch = writer.intake.epoch
    assert.notEqual(nextEpoch, originalEpoch)
    await assert.rejects(() => writer.mutate(before, noExecution), errorCode('UNKNOWN_OUTCOME'))
    await writer.refreshIntake(true)
    assert.notEqual(writer.intake.epoch, nextEpoch)
    assert.notEqual(writer.intake.epoch, originalEpoch)
    assert.equal((await journal(root)).at(-1)!.intake!.epoch, writer.intake.epoch)
  })

  it('expires strictly below the durable boundary and limits future time at first intake', async () => {
    const { writer, root, identity } = await fixture(), base = identity()
    for (const time of [8999, 10101]) {
      await assert.rejects(() => writer.mutate({ ...base, opId: { ...base.opId, time } }, noExecution), errorCode('EXPIRED'))
    }
    for (const time of [9000, 10100]) {
      const input = { ...base, opId: { ...base.opId, time } }
      const outcome = await writer.mutate(input, span => span.finish(root, [], pos => prepared(pos)))
      assert.deepEqual(await writer.mutate(input, noExecution), outcome)
    }
  })

  it('keeps expiry durable across clock rollback and restart', async () => {
    const f = await fixture(), input = f.identity()
    await f.writer.mutate(input, span => span.finish(f.root, [], pos => prepared(pos)))
    f.time(12_001)
    await assert.rejects(() => f.writer.mutate(input, noExecution), errorCode('EXPIRED'))
    assert.equal(f.writer.intake.boundary, 11_001)
    f.time(9500)
    const restarted = await f.open(f.data, 'data:1', 2)
    assert.equal(restarted.intake.boundary, 11_001)
    await assert.rejects(() => restarted.mutate(input, noExecution), errorCode('EXPIRED'))
  })

  it('replays an admitted future-tolerant key after the clock rolls back', async () => {
    const f = await fixture(), input = f.identity()
    const outcome = await f.writer.mutate(input, span => span.finish(f.root, [], pos => prepared(pos)))
    f.time(9500)
    assert.deepEqual(await f.writer.mutate(input, noExecution), outcome)
  })

  it('applies clock tolerance only at first intake of an in-flight request', async () => {
    const f = await fixture(), input = f.identity(), entered = signal(), release = signal()
    const pending = f.writer.mutate(input, async span => {
      entered.resolve(); await release.promise
      return span.finish(f.root, [], pos => prepared(pos))
    })
    await entered.promise
    f.time(9500)
    release.resolve()
    const outcome = await pending
    assert.deepEqual(await f.writer.mutate(input, noExecution), outcome)
  })

  it('does not advance the in-memory intake when persisting its boundary or epoch fails', async () => {
    const f = await fixture(), input = f.identity(), initial = structuredClone(f.writer.intake)
    f.time(12_001); f.fail(true)
    await assert.rejects(() => f.writer.mutate(input, noExecution), (error: unknown) => error === f.failure)
    assert.deepEqual(f.writer.intake, initial)
    await assert.rejects(() => f.writer.refreshIntake(true), (error: unknown) => error === f.failure)
    assert.deepEqual(f.writer.intake, initial)
    f.fail(false)
    await assert.rejects(() => f.writer.mutate(input, noExecution), errorCode('EXPIRED'))
    assert.equal(f.writer.intake.boundary, 11_001)
  })

  it('retains unexpired decisions and the latest durable intake through journal compaction', async () => {
    const f = await fixture(), input = f.identity()
    await f.writer.mutate(input, span => span.finish(f.root, [], pos => prepared(pos, actor.principal, '/items/one')))
    f.time(10_500)
    const retained = f.identity('retained')
    await f.writer.mutate(retained, span => span.finish(f.root, [], pos => prepared(pos)))
    f.time(11_001)
    await f.writer.refreshIntake()
    const records = await journal(f.root), keepFrom = { ...f.writer.position, seq: f.writer.position.seq + 1 }
    const kept = compactJournal(records, keepFrom)
    assert.equal(kept.length, 3)
    assert.deepEqual(kept.map(record => record.entries), [[], [], []])
    assert.deepEqual(kept.at(-1)!.intake, f.writer.intake)
    const expired = compactJournal(records, keepFrom, 10_001)
    assert.equal(expired.length, 2)
    assert.deepEqual(expired[0].decision!.opId, retained.opId)
    assert.deepEqual(expired[1].intake, f.writer.intake)
  })
})
