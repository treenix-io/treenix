import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import { requestHash, type MutationIdentity } from '#kernel/idempotency'
import { openPersistentWriter } from '#kernel/persistence'
import { comparePositions } from '#kernel/position'
import { scanBudget } from '#kernel/store/contract'
import { createFsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { createWriter, type StoreTargetRegistration } from '#kernel/writer'
import type { OpenedStoreMountTarget, Outcome, Position, PositionCounter, Store } from '#kernel/types'

/** Keep the actual root token and issued clock observable in the in-process contract. */
function counter(token: number): PositionCounter {
  let saved: Position | undefined
  return { async load() { return saved }, async save(pos, writerEpoch) { assert.equal(writerEpoch, token); saved = pos },
    async freshEpoch(floor) { return floor + 1 } }
}

it('establishes the complete Fs target floor and acquired fences before the first root effect', { timeout: 10_000 }, async t => {
  const parent = fileURLToPath(new URL('../../../../../temp/writer-startup-target/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'floor-'))
  const rootPath = join(directory, 'root'), targetPath = join(directory, 'target')
  const rootLease = await openPersistentWriter({ directory: join(rootPath, '.treenix'), instance: 'startup' })
  let targetLease = await openPersistentWriter({ directory: join(targetPath, '.treenix'), instance: 'startup' })
  await targetLease.close()
  targetLease = await openPersistentWriter({ directory: join(targetPath, '.treenix'), instance: 'startup' })
  const root = await createFsStore({ directory: rootPath, lease: rootLease })
  const target = await createFsStore({ directory: targetPath, lease: targetLease })
  let closed: Promise<void> | undefined
  const opened: OpenedStoreMountTarget = { kind: 'store', store: target,
    resources: { epoch: targetLease.epoch, persistent: true, writerEpoch: targetLease.writerEpoch, decisionHistory: 'retained' },
    close() { closed ??= (async () => { await target.close(); await targetLease.close() })(); return closed } }
  t.after(async () => { await opened.close(); await root.close(); await rootLease.close() })
  assert.notEqual(rootLease.writerEpoch, targetLease.writerEpoch)
  const floor = { instance: 'startup', epoch: 20, seq: 8 }
  await target.commit({ pos: floor, writerEpoch: targetLease.writerEpoch, writes: [],
    record: { pos: floor, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } })
  const rootEffects: Position[] = []
  const observed: Store = { ...root, async commit(input) { rootEffects.push(input.pos); return root.commit(input) } }
  const registration: StoreTargetRegistration = { key: 'mount', revision: 'configuration', target: opened }
  const startup = { startupTargets: [registration] }
  const writer = await createWriter({ instance: 'startup', root: observed, writerEpoch: rootLease.writerEpoch,
    counter: rootLease, domains: [{ store: observed, epoch: rootLease.epoch, persistent: true }], budget: scanBudget,
    targetLifecycle: { validate() {}, publish() {} }, ...startup })
  t.after(() => writer.closeTargets())
  assert.ok(rootEffects.length > 0)
  assert.ok(comparePositions(rootEffects[0], floor) > 0)
  assert.equal(writer.intake.domains[target.domain], targetLease.epoch)
  const targetRecords = (await target.scan({ range: { journal: '/', after: floor }, budget: scanBudget() })).items
  assert.equal(targetRecords.length, 1)
  const targetFence = targetRecords[0].pos
  assert.ok(comparePositions(targetFence, floor) > 0)
  assert.ok(comparePositions(rootEffects[0], targetFence) > 0)
  assert.equal((await rootLease.load())?.epoch, rootEffects[0].epoch)
  await writer.closeTargets()
  const reacquired = await openPersistentWriter({ directory: join(targetPath, '.treenix'), instance: 'startup' })
  await reacquired.close()
})

it('includes startup decisions before target adoption and never reexecutes a missing old key', { timeout: 10_000 }, async t => {
  const root = createMemoryStore({ domain: 'root' }), target = createMemoryStore({ domain: 'mounted' })
  t.after(() => root.close())
  const actor = { principal: 'u:one' as const, claims: ['u:one'], scope: ['/'] }
  const input: MutationIdentity = { actor, request: { action: 'accepted' },
    opId: { epoch: 'prior-intake', time: Date.now(), nonce: 'accepted' } }
  const pos = { instance: 'startup', epoch: 9, seq: 3 }
  const outcome: Outcome = { pos, value: { accepted: true } }
  await target.commit({ pos, writerEpoch: 3, writes: [],
    record: { pos, kind: 'commit', executor: actor.principal, caller: actor.principal, entries: [],
      decision: { opId: input.opId, requestHash: requestHash(input.request, actor), outcome } } })
  let closes = 0
  const opened: OpenedStoreMountTarget = { kind: 'store', store: target,
    resources: { epoch: 'mounted-continuity', persistent: true, writerEpoch: 3, decisionHistory: 'retained' },
    async close() { closes++; target.close() } }
  const registration: StoreTargetRegistration = { key: 'mount', revision: 'configuration', target: opened }
  const startup = { startupTargets: [registration] }
  const writer = await createWriter({ instance: 'startup', root, writerEpoch: 1, counter: counter(1),
    domains: [{ store: root, epoch: 'root-continuity', persistent: true }], budget: scanBudget,
    targetLifecycle: { validate() {}, publish() {} }, ...startup })
  t.after(() => writer.closeTargets())
  assert.deepEqual(await writer.replay(input), outcome)
  let executed = false
  await assert.rejects(writer.mutate({ ...input, opId: { ...input.opId, nonce: 'missing' } }, async () => { executed = true }),
    (error: unknown) => error instanceof KernelError && error.code === 'UNKNOWN_OUTCOME')
  assert.equal(executed, false)
  await assert.rejects(writer.commit(target, [], position => ({ writes: [], transitions: [],
    record: { pos: position, kind: 'commit', executor: 'kernel', caller: 'kernel', entries: [] } })),
  (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
  const before = writer.stream.cursor()
  const records = (await target.scan({ range: { journal: '/' }, budget: scanBudget() })).items
  await assert.rejects(writer.activateTarget({ ...registration, revision: 'different' }),
    (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
  await assert.rejects(writer.activateTarget({ ...registration, target: { ...opened } }),
    (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
  assert.equal(closes, 0)
  await writer.activateTarget(registration)
  assert.deepEqual(writer.stream.cursor(), before)
  assert.deepEqual((await target.scan({ range: { journal: '/' }, budget: scanBudget() })).items, records)
  await writer.commit(target, [], position => ({ writes: [], transitions: [],
    record: { pos: position, kind: 'commit', executor: 'kernel', caller: 'kernel', entries: [] } }))
  await writer.closeTargets()
  assert.equal(closes, 1)
})

it('rotates unconfirmed startup intake before admission while retaining surviving decisions', async t => {
  const root = createMemoryStore({ domain: 'root' }), target = createMemoryStore({ domain: 'mounted' })
  const pos = { instance: 'startup', epoch: 4, seq: 1 }
  const input: MutationIdentity = { actor: { principal: 'u:one', claims: ['u:one'], scope: ['/'] }, request: {},
    opId: { epoch: 'old-intake', time: Date.now(), nonce: 'accepted' } }
  const outcome: Outcome = { pos, value: 'unchanged' }
  await root.commit({ pos, writerEpoch: 1, writes: [],
    record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [],
      intake: { epoch: input.opId.epoch, boundary: 1, domains: { root: 'root-continuity', mounted: 'renewed-continuity' } } } })
  const accepted = { ...pos, seq: 2 }
  await target.commit({ pos: accepted, writerEpoch: 3, writes: [],
    record: { pos: accepted, kind: 'commit', executor: input.actor.principal, caller: input.actor.principal, entries: [],
      decision: { opId: input.opId, requestHash: requestHash(input.request, input.actor), outcome } } })
  const opened: OpenedStoreMountTarget = { kind: 'store', store: target,
    resources: { epoch: 'renewed-continuity', persistent: true, writerEpoch: 3, decisionHistory: 'unconfirmed' },
    async close() { target.close() } }
  const startup = { startupTargets: [{ key: 'mount', revision: 'configuration', target: opened }] }
  const writer = await createWriter({ instance: 'startup', root, writerEpoch: 1, counter: counter(1),
    domains: [{ store: root, epoch: 'root-continuity', persistent: true }], budget: scanBudget,
    targetLifecycle: { validate() {}, publish() {} }, ...startup })
  t.after(async () => { await writer.closeTargets(); root.close() })
  assert.notEqual(writer.intake.epoch, input.opId.epoch)
  assert.ok(writer.intake.boundary >= 1)
  assert.deepEqual(await writer.replay(input), outcome)
  const intakeRecords = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
  assert.equal(intakeRecords.at(-1)?.intake?.epoch, writer.intake.epoch)
  let executed = false
  await assert.rejects(writer.mutate({ ...input, opId: { ...input.opId, nonce: 'missing' } }, async () => { executed = true }),
    (error: unknown) => error instanceof KernelError && error.code === 'UNKNOWN_OUTCOME')
  assert.equal(executed, false)
})

it('preserves intake for an unchanged constructor-confirmed startup decision inventory', async t => {
  const root = createMemoryStore({ domain: 'root' }), target = createMemoryStore({ domain: 'mounted' })
  const pos = { instance: 'startup', epoch: 3, seq: 1 }
  await root.commit({ pos, writerEpoch: 1, writes: [],
    record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [],
      intake: { epoch: 'confirmed-intake', boundary: 1, domains: { root: 'root-continuity', mounted: 'confirmed-continuity' } } } })
  const opened: OpenedStoreMountTarget = { kind: 'store', store: target,
    resources: { epoch: 'confirmed-continuity', persistent: false, writerEpoch: 3, decisionHistory: 'retained' },
    async close() { target.close() } }
  const startup = { startupTargets: [{ key: 'mount', revision: 'configuration', target: opened }] }
  const writer = await createWriter({ instance: 'startup', root, writerEpoch: 1, counter: counter(1),
    domains: [{ store: root, epoch: 'root-continuity', persistent: true }], budget: scanBudget,
    targetLifecycle: { validate() {}, publish() {} }, ...startup })
  t.after(async () => { await writer.closeTargets(); root.close() })
  assert.equal(writer.intake.epoch, 'confirmed-intake')
  await writer.activateTarget(startup.startupTargets[0])
  assert.equal(writer.intake.epoch, 'confirmed-intake')
})

it('releases owned startup targets on initialization failure and preserves borrowed resources', async () => {
  const failure = new Error('Root initialization refused')
  const root = createMemoryStore({ domain: 'root', beforeRecord() { throw failure } })
  const target = createMemoryStore({ domain: 'mounted' })
  let closes = 0
  const opened: OpenedStoreMountTarget = { kind: 'store', store: target,
    resources: { epoch: 'mounted-continuity', persistent: false, writerEpoch: 0, decisionHistory: 'fresh' },
    async close() { closes++; target.close() } }
  const startup = { startupTargets: [{ key: 'mount', revision: 'configuration', target: opened }] }
  const saved = counter(0)
  await assert.rejects(createWriter({ instance: 'startup', root, writerEpoch: 0, counter: saved,
    domains: [{ store: root, epoch: 'root-continuity', persistent: false }], budget: scanBudget,
    targetLifecycle: { validate() {}, publish() {} }, ...startup }), error => error === failure)
  assert.equal(closes, 1)
  await assert.rejects(target.scan({ range: { node: '/' }, budget: scanBudget() }),
    (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
  assert.deepEqual((await root.scan({ range: { node: '/' }, budget: scanBudget() })).items, [])
  assert.ok(await saved.load())
  root.close()
})
