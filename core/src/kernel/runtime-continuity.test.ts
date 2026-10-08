import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { it } from 'node:test'
import { KernelError } from '#errors'
import { openNativeRuntime } from '#kernel/runtime'
import { drainSession } from '#kernel/session-delivery'
import { decodeCommit } from '#kernel/store/fs-journal'
import type { ModuleManifest, Outcome } from '#kernel/types'

it('refuses reenactment after an earlier accepted decision disappears from the root journal', async () => {
  let executions = 0
  const module: ModuleManifest = { id: 'continuity-probe', security: [], open: [], types: [{
    name: 'probe.effect', module: 'continuity-probe', security: 'ordinary', version: 0,
    schema: {}, actions: { effect: { kind: 'write', args: {}, handler: async () => ++executions } },
  }] }
  const directory = await mkdtemp(resolve('../../temp/k26-root-fs-continuity-data-'))
  const config = { id: 'continuity-probe', directory, credentialTtlMs: 60000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'continuity-probe-password' }, modules: [module] }
  const first = await openNativeRuntime(config)
  assert.ok(first.instance.setupCredential)
  const credential = first.instance.setupCredential

  const session = await first.instance.openSession(credential)
  const delivery = drainSession(session)
  const intake = first.instance.writer.intake.epoch
  const key = { epoch: intake, time: Date.now(), nonce: 'accepted-effect' }
  const tailKey = { ...key, nonce: 'tail' }
  const tailChanges = [{ op: 'put' as const, node: { $path: '/tail', $type: 'probe.effect' } }]
  let tailOutcome: Outcome
  try {
    await session.commit({ opId: { ...key, nonce: 'seed' }, changes: [{ op: 'put', node: {
      $path: '/effect', $type: 'probe.effect',
    } }] }).outcome
    await session.act({ path: '/effect', action: 'effect', args: {}, opId: key }).outcome
    tailOutcome = await session.commit({ opId: tailKey, changes: tailChanges }).outcome
  } finally { await first.close(); await delivery }

  const journalPath = join(directory, '.treenix', 'journal.log')
  const appliedPath = join(directory, '.treenix', 'applied.json')
  const applied = await readFile(appliedPath)
  const journal = await readFile(journalPath)
  const kept: Buffer[] = []
  let removed = 0
  for (let offset = 0; offset < journal.length;) {
    const end = offset + 40 + journal.readUInt32BE(offset)
    const commit = decodeCommit(journal.subarray(offset + 40, end).toString('utf8'))
    if (commit.record.decision?.opId.nonce === key.nonce) {
      assert.equal(commit.writes.length, 0)
      assert.equal(commit.record.entries.length, 0)
      assert.ok(end < journal.length)
      removed++
    } else kept.push(journal.subarray(offset, end))
    offset = end
  }
  assert.equal(removed, 1)

  await writeFile(journalPath, Buffer.concat(kept))
  assert.deepEqual(await readFile(appliedPath), applied)

  const reopened = await openNativeRuntime(config)
  const next = await reopened.instance.openSession(credential)
  const nextDelivery = drainSession(next)
  try {
    assert.ok(await reopened.instance.source.node('/tail'))
    assert.notEqual(reopened.instance.writer.intake.epoch, intake)

    assert.deepEqual(await next.commit({ opId: tailKey, changes: tailChanges }).outcome, tailOutcome)
    await assert.rejects(next.act({ path: '/effect', action: 'effect', args: {}, opId: key }).outcome,
      (error: unknown) => error instanceof KernelError && error.code === 'UNKNOWN_OUTCOME')
    assert.equal(executions, 1)
  } finally { await reopened.close(); await nextDelivery }
})
