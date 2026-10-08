import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { KernelError } from '#errors'
import { openPersistentWriter, type PersistentWriter } from '#kernel/persistence'

const leases: PersistentWriter[] = []
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Keep every test's durable state available for inspection after failures. */
async function scratch(): Promise<string> {
  const parent = resolve('../../temp/fs-continuity')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}

/** Acquire the real external lock and register its owned release. */
async function leaseAt(directory: string): Promise<PersistentWriter> {
  const lease = await openPersistentWriter({ directory, instance: 'test' })
  leases.push(lease)
  return lease
}

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) await lease.close()
})

describe('persistent continuity renewal', { timeout: 30_000 }, () => {
  it('persists a new continuity without changing the acquired fence, domain or issued counter', async () => {
    const directory = await scratch()
    const lease = await leaseAt(directory)
    const epoch = await lease.freshEpoch(0)
    const position = { instance: 'test', epoch, seq: 12 }
    await lease.save(position, lease.writerEpoch)
    const original = lease.epoch
    const before = await readFile(join(directory, 'writer.json'), 'utf8')

    const renewed = await lease.renewContinuity()

    assert.notEqual(renewed, original)
    assert.equal(lease.epoch, renewed)
    assert.deepEqual(await lease.load(), position)
    const state = JSON.parse(await readFile(join(directory, 'writer.json'), 'utf8'))
    assert.deepEqual(state, { ...JSON.parse(before), continuity: renewed })
    await lease.close()

    const reopened = await leaseAt(directory)
    assert.equal(reopened.epoch, renewed)
    assert.equal(reopened.domain, lease.domain)
    assert.ok(reopened.writerEpoch > lease.writerEpoch)
    assert.deepEqual(await reopened.load(), position)
  })

  it('serializes renewals and exposes the latest durably accepted continuity', async () => {
    const directory = await scratch()
    const lease = await leaseAt(directory)
    const original = lease.epoch

    const [first, second] = await Promise.all([lease.renewContinuity(), lease.renewContinuity()])

    assert.notEqual(first, original)
    assert.notEqual(second, first)
    assert.equal(lease.epoch, second)
    assert.equal(JSON.parse(await readFile(join(directory, 'writer.json'), 'utf8')).continuity, second)
  })

  it('refuses renewal after fencing or closing the acquired writer', async () => {
    const lease = await leaseAt(await scratch())
    const original = lease.epoch
    await lease.run(authority => authority.reserveFence(lease.writerEpoch + 1))

    await assert.rejects(() => lease.renewContinuity(), code('CONFLICT'))
    assert.equal(lease.epoch, original)
    await lease.close()
    await assert.rejects(() => lease.renewContinuity(), code('CONFLICT'))
  })

  it('keeps the published continuity unchanged when its durable write is rejected', async () => {
    const directory = await scratch()
    const lease = await leaseAt(directory)
    const original = lease.epoch
    const outside = await scratch()
    const otherState = join(outside, 'state.json')
    const data = JSON.stringify({ owner: 'other' })
    await writeFile(otherState, data)
    await rename(join(directory, 'writer.json'), join(directory, 'writer-preserved.json'))
    await symlink(otherState, join(directory, 'writer.json'))

    await assert.rejects(() => lease.renewContinuity(), code('FORBIDDEN'))

    assert.equal(lease.epoch, original)
    assert.equal(await readFile(otherState, 'utf8'), data)
  })

  it('preserves continuity across default lease reopen when renewal is not requested', async () => {
    const directory = await scratch()
    const lease = await leaseAt(directory)
    await lease.close()

    const reopened = await leaseAt(directory)

    assert.equal(reopened.epoch, lease.epoch)
    assert.equal(reopened.domain, lease.domain)
    assert.ok(reopened.writerEpoch > lease.writerEpoch)
  })
})
