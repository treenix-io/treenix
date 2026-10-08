import { KernelError } from '#errors'
import { AUTH_KEY_PATH, type AdminInput } from '#kernel/auth-module'
import { assertAuthKey, assertBootstrapState, bootstrap, bootstrapIdentity, bootstrapModules, LIMITS_PATH,
  ownershipRecord, storedLimits, TYPE_PATH, type BootstrapIdentity } from '#kernel/bootstrap'
import type { Image } from '#kernel/cache'
import { createChainIndex } from '#kernel/chain-index'
import { prepareChangeSet, type ChangeExecutor } from '#kernel/changeset'
import { createRegistry, type TypeOwnership } from '#kernel/registry'
import type { AuthReadSource, AuthSource } from '#kernel/session'
import type { StreamDomain } from '#kernel/stream'
import { DEFAULT_LIMITS, type Budget, type ChangeMember, type InstanceId, type Limits, type NodeId,
  type Position, type Store, type StoreCommit, type StoredNode } from '#kernel/types'
import { createWriter, type PositionCounter } from '#kernel/writer'

export interface InstanceFoundationConfig {
  readonly id: InstanceId
  readonly root: Store
  readonly writerEpoch: number
  readonly domains: readonly StreamDomain[]
  readonly counter: PositionCounter
  readonly firstAdmin?: AdminInput
  readonly budget?: () => Budget
}

export async function createInstanceFoundation(input: InstanceFoundationConfig) {
  const { firstAdmin, domains, ...options } = input
  const config: InstanceFoundationConfig = Object.freeze({ ...options,
    domains: Object.freeze(domains.map(domain => Object.freeze({ ...domain }))),
    ...(firstAdmin === undefined ? {} : { firstAdmin: Object.freeze({ ...firstAdmin }) }) })
  if (config.id.length === 0 || !Number.isSafeInteger(config.writerEpoch) || config.writerEpoch < 0)
    throw new KernelError('INVALID', 'Invalid instance lease identity')
  let limits: Limits = DEFAULT_LIMITS
  const budget = config.budget ?? (() => ({ nodes: limits.readNodes, bytes: limits.readBytes,
    exprWork: limits.exprWork, deadline: Date.now() + limits.queryMs }))
  // Check the binding before fencing: opening another instance must not acquire its Store lease.
  const storedRoot = (await config.root.scan({ range: { node: '/' }, budget: budget() })).items[0]
  if (storedRoot !== undefined) {
    bootstrapIdentity(storedRoot, config.id)
    const key = (await config.root.scan({ range: { node: AUTH_KEY_PATH }, budget: budget() })).items[0]
    assertAuthKey(key ?? null, config.id)
    if (config.firstAdmin !== undefined) throw new KernelError('INVALID', 'First-account provisioning requires an empty instance')
  } else if (config.firstAdmin === undefined) throw new KernelError('INVALID', 'First-account provisioning is required')

  const paths = new Map<string, NodeId>(), ids = new Map<NodeId, string>()
  const owners = new Map<string, TypeOwnership>(), chains = createChainIndex()
  let identity: BootstrapIdentity | undefined
  let accepted = false, failure: { readonly error: unknown } | undefined
  const registry = createRegistry({ ownership: name => owners.get(name) })

  function available(): void { if (failure !== undefined) throw failure.error }
  function validate(changed: ReadonlyMap<string, StoredNode | null>): void {
    if (!accepted) {
      const fresh = new Map<string, StoredNode>()
      for (const [path, node] of changed) if (node !== null) fresh.set(path, node)
      assertBootstrapState(config.id, fresh)
    }
    for (const [path, node] of changed) {
      if (path === '/') {
        if (node === null) throw new KernelError('FORBIDDEN', 'Instance root is required')
        const next = bootstrapIdentity(node, config.id)
        if (identity !== undefined && (identity.adminId !== next.adminId || identity.adminPath !== next.adminPath))
          throw new KernelError('FORBIDDEN', 'Bootstrap identity is immutable')
      }
      if (path === AUTH_KEY_PATH) assertAuthKey(node, config.id)
      if (path === LIMITS_PATH) {
        if (node === null) throw new KernelError('FORBIDDEN', 'Instance limits are required')
        storedLimits(node)
      }
      if (path.startsWith(`${TYPE_PATH}/`) || node?.$type === 't.type') {
        const previous = owners.get(path.slice(TYPE_PATH.length + 1))
        if (node === null) throw new KernelError('FORBIDDEN', 'Persisted type ownership is required')
        const next = ownershipRecord(node)
        if (previous !== undefined && (previous.module !== next.module || previous.security !== next.security))
          throw new KernelError('FORBIDDEN', 'Persisted type ownership is immutable')
      }
      if (node !== null) {
        const prior = ids.get(node.$id)
        if (prior !== undefined && prior !== path && !changed.has(prior)) throw new KernelError('INVALID', 'Duplicate accepted node identity')
      }
    }
  }
  function put(node: StoredNode): void {
    const path = ids.get(node.$id)
    if (path !== undefined && path !== node.$path) throw new KernelError('INVALID', 'Duplicate accepted node identity')
    paths.set(node.$path, node.$id); ids.set(node.$id, node.$path); chains.put(node)
    if (node.$path.startsWith(`${TYPE_PATH}/`) || node.$type === 't.type') {
      const owner = ownershipRecord(node)
      owners.set(node.$path.slice(TYPE_PATH.length + 1), owner)
    }
    if (node.$path === LIMITS_PATH) limits = storedLimits(node)
  }
  function remove(path: string): void {
    const id = paths.get(path)
    if (id !== undefined) ids.delete(id)
    paths.delete(path); chains.remove(path)
    if (path.startsWith(`${TYPE_PATH}/`)) owners.delete(path.slice(TYPE_PATH.length + 1))
  }
  function publish(_domain: string, commit: StoreCommit, images: readonly Image[], store: Store): void {
    if (store !== config.root || commit.writes.length === 0) return
    try {
      const changed = new Map<string, StoredNode | null>(commit.writes.map(write => [write.path, null]))
      for (const image of images) if (image.node !== null) changed.set(image.path, image.node)
      validate(changed)
      for (const write of commit.writes) remove(write.path)
      for (const image of images) if (image.node !== null) put(image.node)
      accepted = true
    } catch (error) {
      failure = { error }
      throw error
    }
  }
  const writer = await createWriter({ instance: config.id, root: config.root, writerEpoch: config.writerEpoch,
    domains: config.domains, counter: config.counter, budget, applied: publish })
  const initial = await writer.cache.fill(config.root, { subtree: '/' }, budget())
  try {
    for (const node of initial.nodes) put(node)
    if (storedRoot !== undefined) identity = assertBootstrapState(config.id, new Map(initial.nodes.map(node => [node.$path, node])))
  } finally { initial.release() }

  function reader(allowance: Budget, active = () => true): AuthReadSource {
    function check(): void {
      available()
      if (!active()) throw new KernelError('INVALID', 'Read scope has ended')
      if (Date.now() > allowance.deadline) throw new KernelError('BUDGET', 'Read deadline exceeded')
    }
    const readSource: AuthReadSource = {
      async node(path) {
        check()
        const id = paths.get(path)
        if (id === undefined) return null
        const lease = await writer.cache.fill(config.root, { node: path }, allowance)
        try {
          const node = lease.nodes[0]
          if (node === undefined || node.$id !== id) throw new KernelError('INVALID', 'Accepted identity differs from the root Store')
          return node
        } finally { lease.release() }
      },
      async nodeById(id) { check(); const path = ids.get(id); return path === undefined ? null : readSource.node(path) },
      shard() { check(); return false },
    }
    return readSource
  }
  const source: AuthSource = {
    node: path => source.read(read => read.node(path)),
    nodeById: id => source.read(read => read.nodeById(id)),
    shard() { available(); return false },
    read(run) {
      let active = true
      const readSource = reader(budget(), () => active)
      return writer.read([config.root.domain], async () => {
        try { return await run(readSource) } finally { active = false }
      })
    },
  }
  if (storedRoot === undefined) {
    if (paths.size !== 0) throw new KernelError('INVALID', 'Bootstrap requires an empty root Store')
    const admin = config.firstAdmin
    if (admin === undefined) throw new KernelError('INVALID', 'First-account provisioning is required')
    identity = await bootstrap({ instance: config.id, store: config.root, writer, cache: writer.cache,
      admin, budget, node: async path => reader(budget()).node(path) })
  } else {
    accepted = true
  }
  if (identity === undefined) throw new KernelError('INVALID', 'Instance bootstrap identity is absent')
  for (const module of bootstrapModules) registry.publish(module)

  async function commit(changes: readonly ChangeMember[], who: ChangeExecutor): Promise<Position> {
    available()
    if (!accepted) throw new KernelError('INVALID', 'Instance is not bootstrapped')
    return writer.commit(config.root, [], async pos => {
      const allowance = budget(), readSource = reader(allowance)
      const prepared = await prepareChangeSet({ store: config.root, cache: writer.cache, registry, limits,
        budget: allowance, readBefore: readSource.node, capabilities: { node: readSource.nodeById,
          grants: principal => chains.grantsTo(principal), ownerGrants: chains.grants({ owner: true }), shard: readSource.shard } },
      changes, pos, who)
      validate(new Map(prepared.writes.map(write => [write.path, write.node])))
      return prepared
    })
  }
  return { id: config.id, root: config.root, registry, writer, source, bootstrap: identity,
    limits() { available(); return limits }, commit }
}
