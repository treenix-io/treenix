import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { openNativeRuntime } from '#kernel/runtime'
import { scanBudget } from '#kernel/store/contract'
import type { Credential, ModuleManifest, OpId, Outcome, Position } from '#kernel/types'

const module: ModuleManifest = { id: 'runtime-counter', types: [{ name: 'runtime.counter', module: 'runtime-counter',
  security: 'ordinary', version: 0, schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
  actions: { increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } } } }], security: [], open: [] }
async function config() {
  const temp = resolve('temp'); await mkdir(temp, { recursive: true })
  return { id: 'native-runtime', directory: await mkdtemp(join(temp, 'native-runtime-')), credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'runtime-test-password' }, modules: [module] }
}

describe('persistent native runtime', { timeout: 20_000 }, () => {
  it('reopens configured modules, identity and a persisted action outcome without resetting the node', async () => {
    const input = await config(), first = await openNativeRuntime(input)
    let originalId: string, outcome: Outcome, key: OpId
    try {
      assert.ok(first.instance.setupCredential)
      const commands = first.instance.commands(await first.instance.auth.openCredential(first.instance.setupCredential))
      await commands.commit({ changes: [{ op: 'put', node: { $path: '/counter', $type: 'runtime.counter', count: 0 } }],
        opId: { epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: 'create' } })
      key = { epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: 'increment' }
      outcome = await commands.act({ path: '/counter', action: 'increment', args: {}, opId: key })
      originalId = first.instance.bootstrap.adminId
      assert.equal((await first.instance.source.node('/counter'))?.count, 1)
    } finally { await first.close() }
    const reopened = await openNativeRuntime(input)
    try {
      assert.equal(reopened.instance.bootstrap.adminId, originalId)
      assert.equal(reopened.instance.setupCredential, undefined)
      const credential = await reopened.instance.auth.login({ account: '/admin', password: 'runtime-test-password' })
      const commands = reopened.instance.commands(await reopened.instance.auth.openCredential(credential))
      assert.deepEqual(await commands.act({ path: '/counter', action: 'increment', args: {}, opId: key }), outcome)
      assert.equal((await reopened.instance.source.node('/counter'))?.count, 1)
      assert.equal(reopened.instance.registry.type('runtime.counter').module, module.id)
    } finally { await reopened.close() }
  })

  it('refuses a module claiming persisted foreign type ownership', async () => {
    const input = await config(), first = await openNativeRuntime(input)
    await first.close()
    const foreign: ModuleManifest = { ...module, id: 'foreign', types: module.types.map(type => ({ ...type, module: 'foreign' })) }
    await assert.rejects(openNativeRuntime({ ...input, modules: [foreign] }), (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN')
    const reopened = await openNativeRuntime(input)
    try { assert.equal(reopened.instance.registry.type('runtime.counter').module, module.id) } finally { await reopened.close() }
  })

  it('refuses new type installation below one transition without durable empty commits or a retained lock', async () => {
    const input = { ...await config(), modules: [] }, first = await openNativeRuntime(input)
    let installerCredential: Credential, baseline: Position
    try {
      assert.ok(first.instance.setupCredential); installerCredential = first.instance.setupCredential
      const commands = first.instance.commands(await first.instance.auth.openCredential(installerCredential))
      const outcome = await commands.commit({ opId: { epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: 'fractional-limit' },
        changes: [{ op: 'put', node: { $path: '/sys/limits', $type: 't.limits', changeSet: 0.5 } }] })
      assert.ok(outcome.pos); baseline = outcome.pos
      assert.equal(first.instance.limits().changeSet, 0.5)
    } finally { await first.close() }
    await assert.rejects(openNativeRuntime({ ...input, modules: [module], installerCredential }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET')
    const reopened = await openNativeRuntime(input)
    try {
      assert.equal(await reopened.instance.source.node('/sys/types/runtime.counter'), null)
      const records = (await reopened.store.scan({ range: { journal: '/', after: baseline }, budget: scanBudget() })).items
      assert.deepEqual(records.filter(record => record.kind === 'commit'), [])
      assert.equal(reopened.instance.setupCredential, undefined)
    } finally { await reopened.close() }
  })

  it('floors a fractional transition budget and persists each configured type under the real installer', async () => {
    const input = { ...await config(), modules: [] }, first = await openNativeRuntime(input)
    let installerCredential: Credential, baseline: Position, principal: string
    try {
      assert.ok(first.instance.setupCredential); installerCredential = first.instance.setupCredential
      const commands = first.instance.commands(await first.instance.auth.openCredential(installerCredential))
      principal = commands.actor.principal
      const outcome = await commands.commit({ opId: { epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: 'fractional-limit' },
        changes: [{ op: 'put', node: { $path: '/sys/limits', $type: 't.limits', changeSet: 1.5 } }] })
      assert.ok(outcome.pos); baseline = outcome.pos
    } finally { await first.close() }
    const manifest: ModuleManifest = { id: 'runtime-batched', types: ['first', 'second', 'third'].map((name): ModuleManifest['types'][number] => ({
      name: `runtime.${name}`, module: 'runtime-batched', security: 'ordinary', version: 0, schema: {}, actions: {},
    })), security: [], open: [] }
    const reopened = await openNativeRuntime({ ...input, modules: [manifest], installerCredential })
    try {
      for (const type of manifest.types) {
        assert.equal(reopened.instance.registry.type(type.name).module, manifest.id)
        assert.equal((await reopened.instance.source.node(`/sys/types/${type.name}`))?.module, manifest.id)
      }
      const records = (await reopened.store.scan({ range: { journal: '/', after: baseline }, budget: scanBudget() })).items
      const installations = records.filter(record => record.entries.some(entry => entry.path.startsWith('/sys/types/runtime.')))
      assert.equal(installations.length, 3)
      for (const record of installations) {
        assert.equal(record.entries.length, 1)
        assert.equal(record.executor, principal); assert.equal(record.caller, principal)
        assert.ok(record.decision?.opId)
      }
    } finally { await reopened.close() }
  })
})
