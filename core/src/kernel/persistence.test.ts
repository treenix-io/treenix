import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import { openPersistentWriter } from '#kernel/persistence'
import { createFsStore } from '#kernel/store/fs'
import { position, storeCommit, storedNode } from '#kernel/store/contract'
import { isRecord } from '#util/is-record'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
async function directory(): Promise<string> {
  const parent = resolve('../../temp/k41-counter')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}
function run(mode: string, directory: string): ChildProcess {
  return fork(fileURLToPath(new URL('./store/fs-process-fixture.ts', import.meta.url)), [mode, directory], {
    execArgv: ['--conditions=development', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    signal: AbortSignal.timeout(10_000),
    env: { ...process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '' },
  })
}
async function result(child: ChildProcess): Promise<Record<string, unknown>> {
  const data = await Promise.race([once(child, 'message'), once(child, 'exit').then(([exit]) => { throw new Error(`Child exited before reporting: ${exit}`) })])
  const value: unknown = data[0]
  assert.ok(isRecord(value))
  return value
}

describe('persistent writer authority', { timeout: 30_000 }, () => {
  it('holds an actual process lock until explicit close and releases it after a killed process', async () => {
    const root = await directory(), holder = run('lock', root)
    try {
      assert.equal((await result(holder)).type, 'locked')
      await assert.rejects(openPersistentWriter({ directory: join(root, '.treenix'), instance: 'test' }), code('CONFLICT'))
      const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited
      const lease = await openPersistentWriter({ directory: join(root, '.treenix'), instance: 'test' })
      try { assert.ok(lease.writerEpoch > 1) } finally { await lease.close() }
    } finally { if (holder.exitCode === null && holder.signalCode === null) { const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited } }
    const next = await openPersistentWriter({ directory: join(root, '.treenix'), instance: 'test' })
    await next.close()
    const after = await openPersistentWriter({ directory: join(root, '.treenix'), instance: 'test' })
    try { assert.ok(after.writerEpoch > next.writerEpoch) } finally { await after.close() }
  })

  it('continues genuine Writer reservations across two independent processes', async () => {
    const root = await directory(), first = run('writer', root)
    const initial = await result(first); assert.equal(initial.type, 'position'); await once(first, 'exit')
    const second = run('writer', root), next = await result(second); assert.equal(next.type, 'position'); await once(second, 'exit')
    assert.ok(isRecord(initial.pos) && isRecord(next.pos))
    assert.equal(initial.pos.epoch, next.pos.epoch)
    assert.equal(initial.epoch, next.epoch)
    assert.ok(typeof initial.pos.seq === 'number' && typeof next.pos.seq === 'number' && next.pos.seq > initial.pos.seq)
    assert.ok(typeof initial.writerEpoch === 'number' && typeof next.writerEpoch === 'number' && next.writerEpoch > initial.writerEpoch)
  })

  it('preserves failed reservation gaps and reserves above durable high-water when the counter is lost', async () => {
    const root = await directory(), state = join(root, '.treenix')
    let lease = await openPersistentWriter({ directory: state, instance: 'test' })
    const epoch = await lease.freshEpoch(0)
    await lease.save({ instance: 'test', epoch, seq: 51 }, lease.writerEpoch)
    await lease.close()
    lease = await openPersistentWriter({ directory: state, instance: 'test' })
    assert.deepEqual(await lease.load(), { instance: 'test', epoch, seq: 51 })
    await lease.close()
    await rename(join(state, 'position.json'), join(state, 'position-preserved.json'))
    lease = await openPersistentWriter({ directory: state, instance: 'test' })
    try {
      assert.equal(await lease.load(), undefined)
      const next = await lease.freshEpoch(0)
      assert.ok(next > epoch)
      await lease.save({ instance: 'test', epoch: next, seq: 1 }, lease.writerEpoch)
      await assert.rejects(lease.save({ instance: 'test', epoch: next, seq: 0 }, lease.writerEpoch), code('CONFLICT'))
    } finally { await lease.close() }
  })

  it('durably fences the original counter authority when the Store accepts a newer writer', async () => {
    const root = await directory(), lease = await openPersistentWriter({ directory: join(root, '.treenix'), instance: 'test' })
    const store = await createFsStore({ directory: root, lease })
    const epoch = await lease.freshEpoch(0)
    await store.commit(storeCommit(1, [storedNode('/accepted')], [], lease.writerEpoch + 3))
    for (const operation of [() => lease.load(), () => lease.freshEpoch(epoch), () => lease.save(position(2), lease.writerEpoch)]) await assert.rejects(operation, code('CONFLICT'))
    await assert.rejects(store.commit(storeCommit(2, [storedNode('/stale')], [], lease.writerEpoch)), code('CONFLICT'))
    const before = lease.writerEpoch
    await store.close(); await lease.close()
    const next = await openPersistentWriter({ directory: join(root, '.treenix'), instance: 'test' })
    try { assert.ok(next.writerEpoch > before + 3) } finally { await next.close() }
  })

  it('detects a restored counter below an issued gap absent from every journal', async () => {
    const root = await directory(), state = join(root, '.treenix')
    const lease = await openPersistentWriter({ directory: state, instance: 'test' })
    const epoch = await lease.freshEpoch(0)
    await lease.save({ instance: 'test', epoch, seq: 9 }, lease.writerEpoch)
    await lease.close()
    await writeFile(join(state, 'position.json'), JSON.stringify({ instance: 'test', epoch, seq: 2 }))
    const next = await openPersistentWriter({ directory: state, instance: 'test' })
    try {
      assert.equal(await next.load(), undefined)
      await assert.rejects(next.save({ instance: 'test', epoch, seq: 3 }, next.writerEpoch), code('CONFLICT'))
      const fresh = await next.freshEpoch(epoch)
      assert.ok(fresh > epoch)
      await next.save({ instance: 'test', epoch: fresh, seq: 0 }, next.writerEpoch)
      assert.deepEqual(await next.load(), { instance: 'test', epoch: fresh, seq: 0 })
    } finally { await next.close() }
  })

  it('rejects corrupted state, missing lease history and cross-instance reuse without taking another owner lock', async () => {
    const root = await directory(), state = join(root, '.treenix'), lease = await openPersistentWriter({ directory: state, instance: 'test' })
    await assert.rejects(openPersistentWriter({ directory: state, instance: 'other' }), code('CONFLICT'))
    await lease.close()
    await assert.rejects(openPersistentWriter({ directory: state, instance: 'other' }), code('INVALID'))
    await rename(join(state, 'writer.json'), join(state, 'writer-preserved.json'))
    await writeFile(join(state, 'position.json'), JSON.stringify(position(9)))
    await assert.rejects(openPersistentWriter({ directory: state, instance: 'test' }), code('INVALID'))
    await writeFile(join(state, 'writer.json'), '{"instance":"test","writerEpoch":null}')
    await assert.rejects(openPersistentWriter({ directory: state, instance: 'test' }), code('INVALID'))
  })
})
