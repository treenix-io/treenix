import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { KernelError } from '#errors'
import type { AdminInput } from '#kernel/auth-module'
import { bootstrapModules, ownershipRecord, TYPE_PATH } from '#kernel/bootstrap'
import { createInstanceFoundation, type InstanceFoundationWithAuth } from '#kernel/instance'
import { openPersistentWriter } from '#kernel/persistence'
import { copyManifest, createRegistry } from '#kernel/registry'
import { createFsStore } from '#kernel/store/fs'
import { createFsBlobStore } from '#kernel/blob-store-fs'
import { DEFAULT_LIMITS, type ChangeMember, type Credential, type Gate, type ModuleManifest } from '#kernel/types'

export interface NativeRuntimeConfig {
  readonly id: string
  readonly directory: string
  readonly credentialTtlMs: number
  readonly firstAdmin?: AdminInput
  readonly installerCredential?: Credential
  readonly modules?: readonly ModuleManifest[]
  readonly gates?: readonly Gate[]
}

async function installModules(instance: InstanceFoundationWithAuth, modules: readonly ModuleManifest[], installerCredential?: Credential): Promise<void> {
  const changes: ChangeMember[] = []
  for (const module of modules) for (const type of module.types) for (const name of [type.name, ...type.aliases ?? []]) {
    const path = `${TYPE_PATH}/${name}`, previous = await instance.source.node(path)
    if (previous !== null) {
      const owner = ownershipRecord(previous)
      if (owner.module !== type.module || owner.security !== type.security) throw new KernelError('FORBIDDEN', 'Module differs from persisted type ownership')
    } else changes.push({ op: 'put', node: { $path: path, $type: 't.type', name, module: type.module, security: type.security } })
  }
  const capacity = Math.floor(instance.limits().changeSet)
  if (changes.length > 0) {
    if (capacity < 1) throw new KernelError('BUDGET', 'Type ownership installation exceeds the commit limit')
    const credential = instance.setupCredential ?? installerCredential
    if (credential === undefined) throw new KernelError('UNAUTHENTICATED', 'Module installation requires a credential')
    const commands = instance.commands(await instance.auth.openCredential(credential))
    try {
      for (let i = 0; i < changes.length; i += capacity)
        await commands.commit({ changes: changes.slice(i, i + capacity),
          opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() } })
    } finally { commands.close() }
  }
  for (const module of modules) instance.registry.publish(module)
}

export async function openNativeRuntime(input: NativeRuntimeConfig) {
  const modules = (input.modules ?? []).map(copyManifest), firstAdmin = input.firstAdmin === undefined ? undefined : Object.freeze({ ...input.firstAdmin })
  const config = Object.freeze({ id: input.id, directory: input.directory, credentialTtlMs: input.credentialTtlMs,
    installerCredential: input.installerCredential === undefined ? undefined : Object.freeze({ ...input.installerCredential }),
    gates: Object.freeze([...input.gates ?? []]) })
  if (!Number.isFinite(config.credentialTtlMs) || config.credentialTtlMs <= 0)
    throw new KernelError('INVALID', 'Credential lifetime must be positive and finite')
  const preview = createRegistry(), moduleIds = new Set(bootstrapModules.map(module => module.id))
  for (const module of bootstrapModules) preview.publish(module)
  for (const module of modules) {
    if (moduleIds.has(module.id)) throw new KernelError('CONFLICT', 'Duplicate configured module')
    moduleIds.add(module.id); preview.publish(module)
  }
  const lease = await openPersistentWriter({ directory: join(config.directory, '.treenix'), instance: config.id })
  let store: Awaited<ReturnType<typeof createFsStore>>
  try { store = await createFsStore({ directory: config.directory, lease }) }
  catch (error) { await lease.close(); throw error }
  let foundation: InstanceFoundationWithAuth | undefined
  async function release(): Promise<void> {
    foundation?.auth.close()
    try { await store.close() } finally { await lease.close() }
  }
  try {
    const existing = await store.scan({ range: { node: '/' }, budget: { nodes: 1, bytes: DEFAULT_LIMITS.readBytes,
      exprWork: DEFAULT_LIMITS.exprWork, deadline: Date.now() + DEFAULT_LIMITS.queryMs } })
    foundation = await createInstanceFoundation({ id: config.id, root: store, writerEpoch: lease.writerEpoch,
      blobs: await createFsBlobStore(join(config.directory, '.treenix', 'blobs')),
      counter: lease, domains: [{ store, epoch: lease.epoch, persistent: true }], gates: config.gates,
      initialCredential: { ttlMs: config.credentialTtlMs }, ...(existing.items.length === 0 && firstAdmin !== undefined ? { firstAdmin } : {}) })
    await installModules(foundation, modules, config.installerCredential)
    let closing: Promise<void> | undefined
    return { instance: foundation, store, close() { return closing ??= release() } }
  } catch (error) { await release(); throw error }
}
