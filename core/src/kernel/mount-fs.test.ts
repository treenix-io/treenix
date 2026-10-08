import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { KernelError } from '#errors'
import { openFsMountTarget, type FsMountTarget } from '#kernel/mount-fs'
import { openPersistentWriter } from '#kernel/persistence'
import { scanBudget, storeCommit, storedNode } from '#kernel/store/contract'
import { isRecord } from '#util/is-record'

const targets: FsMountTarget[] = []
const children: ChildProcess[] = []
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Wait for a resource event without timing-dependent sleeps. */
function latch() {
  let release: () => void = () => { throw new Error('Latch was not initialized') }
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

/** Preserve unique datasets instead of cleaning up recovery evidence. */
async function scratch(): Promise<string> {
  const parent = resolve('../../temp/fs-mount-resource')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}

/** Track only this test's acquired resources. */
async function targetAt(directory: string): Promise<FsMountTarget> {
  const target = await openFsMountTarget({ directory, instance: 'test', logicalBase: '/mounted' })
  targets.push(target)
  return target
}

/** Use a bounded real process so lease ownership never relies on an in-process substitute. */
function run(mode: string, directory: string): ChildProcess {
  const child = fork(fileURLToPath(new URL('./mount-fs-process-fixture.ts', import.meta.url)), [mode, directory], {
    execArgv: ['--conditions=development', '--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    signal: AbortSignal.timeout(10_000),
    env: { ...process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '' },
  })
  children.push(child)
  return child
}

/** Decode the child-process boundary loudly before inspecting its report. */
async function result(child: ChildProcess): Promise<Record<string, unknown>> {
  const received = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([exit]) => { throw new Error(`Child exited before reporting: ${exit}`) }),
  ])
  const value: unknown = received[0]
  assert.ok(isRecord(value))
  return value
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }

  for (const target of targets.splice(0).reverse()) await target.close()
})

describe('filesystem mount resources', { timeout: 45_000 }, () => {
  it('returns actual durable fencing authority and an explicitly unconfirmed renewed continuity', async () => {
    const directory = await scratch()
    const prior = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
    const previous = { domain: prior.domain, epoch: prior.epoch, writerEpoch: prior.writerEpoch }
    await prior.close()

    const target = await targetAt(directory)
    const state = JSON.parse(await readFile(join(directory, '.treenix/writer.json'), 'utf8'))

    assert.equal(target.store.domain, previous.domain)
    assert.notEqual(target.resources.epoch, previous.epoch)
    assert.equal(target.resources.epoch, state.continuity)
    assert.equal(target.resources.writerEpoch, state.writerEpoch)
    assert.ok(target.resources.writerEpoch > previous.writerEpoch)
    assert.equal(target.resources.persistent, true)
    assert.equal(target.resources.decisionHistory, 'unconfirmed')
    await assert.rejects(() => openFsMountTarget({ directory, instance: 'test', logicalBase: '/mounted' }), code('CONFLICT'))
  })

  it('preserves accepted data and the canonical decision through an actual process restart', async () => {
    const directory = await scratch()
    const first = run('seed', directory)
    const firstExit = once(first, 'exit')
    const initial = await result(first)
    assert.deepEqual(await firstExit, [0, null])

    const second = run('recover', directory)
    const secondExit = once(second, 'exit')
    const recovered = await result(second)
    assert.deepEqual(await secondExit, [0, null])

    assert.ok(isRecord(initial.resources) && isRecord(recovered.resources))
    assert.equal(recovered.domain, initial.domain)
    assert.notEqual(recovered.resources.epoch, initial.resources.epoch)
    assert.ok(typeof recovered.resources.writerEpoch === 'number' && typeof initial.resources.writerEpoch === 'number')
    assert.ok(recovered.resources.writerEpoch > initial.resources.writerEpoch)
    assert.equal(recovered.resources.decisionHistory, 'unconfirmed')
    assert.deepEqual(recovered.nodes, initial.nodes)
    assert.deepEqual(recovered.decision, initial.decision)
    assert.ok(Array.isArray(recovered.decision) && recovered.decision.length === 1)
    assert.deepEqual(recovered.decision[0].decision.outcome, { pos: { instance: 'test', epoch: 1, seq: 1 }, value: 'canonical' })
    const state = JSON.parse(await readFile(join(directory, '.treenix/writer.json'), 'utf8'))
    assert.equal(state.continuity, recovered.resources.epoch)
  })

  it('releases a killed process lock and renews its durable continuity before returning a replacement', async () => {
    const directory = await scratch()
    const holder = run('hold', directory)
    const held = await result(holder)
    assert.ok(isRecord(held.resources))
    await assert.rejects(() => openFsMountTarget({ directory, instance: 'test', logicalBase: '/mounted' }), code('CONFLICT'))
    const exited = once(holder, 'exit')
    holder.kill('SIGKILL')
    await exited

    const replacement = await targetAt(directory)

    assert.equal(replacement.store.domain, held.domain)
    assert.notEqual(replacement.resources.epoch, held.resources.epoch)
    assert.ok(typeof held.resources.writerEpoch === 'number')
    assert.ok(replacement.resources.writerEpoch > held.resources.writerEpoch)
    assert.equal(JSON.parse(await readFile(join(directory, '.treenix/writer.json'), 'utf8')).continuity, replacement.resources.epoch)
  })

  it('shares one close promise, waits for Store release, and releases the lease even when Store close fails', async () => {
    const directory = await scratch()
    const target = await openFsMountTarget({ directory, instance: 'test', logicalBase: '/mounted' })
    const original = target.store.close
    const failure = new Error('Injected Store release failure')
    const entered = latch()
    const release = latch()
    let calls = 0
    target.store.close = async () => {
      calls++
      entered.release()
      await release.promise
      await original()
      throw failure
    }

    const first = target.close()
    const second = target.close()
    const firstRejected = assert.rejects(first, error => error === failure)
    const secondRejected = assert.rejects(second, error => error === failure)
    assert.equal(first, second)
    await entered.promise
    await assert.rejects(() => openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' }), code('CONFLICT'))
    release.release()
    await Promise.all([firstRejected, secondRejected])

    assert.equal(calls, 1)
    const replacement = await targetAt(directory)
    assert.ok(replacement.resources.writerEpoch > target.resources.writerEpoch)
    assert.throws(() => target.store.scan({ range: { subtree: '/mounted' }, budget: scanBudget() }), code('CONFLICT'))
  })

  it('releases an initialization failure and refuses cross-instance resource reuse', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'broken.json'), '{')
    await assert.rejects(() => openFsMountTarget({ directory, instance: 'test', logicalBase: '/mounted' }), SyntaxError)
    await rename(join(directory, 'broken.json'), join(await scratch(), 'broken-preserved.json'))

    const target = await targetAt(directory)
    await target.close()
    await assert.rejects(() => openFsMountTarget({ directory, instance: 'other', logicalBase: '/mounted' }), code('INVALID'))
    const reopened = await targetAt(directory)

    assert.equal(reopened.store.domain, target.store.domain)
    assert.ok(reopened.resources.writerEpoch > target.resources.writerEpoch)
  })

  it('rejects stale fencing without losing the target lease or its accepted journal', async () => {
    const target = await targetAt(await scratch())
    const first = storeCommit(1, [storedNode('/mounted/doc', { value: 'accepted' })], [], target.resources.writerEpoch)
    await target.store.commit(first)
    await assert.rejects(() => target.store.commit(storeCommit(2, [storedNode('/mounted/stale')], [], target.resources.writerEpoch - 1)), code('CONFLICT'))

    assert.deepEqual((await target.store.scan({ range: { journal: '/mounted' }, budget: scanBudget() })).items, [first.record])
    assert.deepEqual((await target.store.scan({ range: { subtree: '/mounted' }, budget: scanBudget() })).items, first.writes.map(write => write.node))
  })
})
