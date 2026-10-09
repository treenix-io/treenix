import { KernelError } from '#errors'
import { AUTH_KEY_PATH, assertAdminInput } from '#kernel/auth-module'
import { createAuthFactory, type AuthEvent, type AuthFactory } from '#kernel/auth-factory'
import { recheckLogin } from '#kernel/auth/login'
import { assertAdminPath, assertAuthKey, assertBootstrapState, bootstrap, bootstrapIdentity, bootstrapModules, LIMITS_PATH,
  ownershipRecord, storedLimits, TYPE_PATH, type BootstrapIdentity } from '#kernel/bootstrap'
import { createProcessCache, type Image } from '#kernel/cache'
import { createBlobTransfers } from '#kernel/blobs'
import { createAcceptedTargets } from '#kernel/instance-targets'
import { prepareChangeSet, type ChangeExecutor } from '#kernel/changeset'
import { createCommands, type CommandOptions, type NativeCommands, type NodeActionBinding, type NodeActionTarget } from '#kernel/commands'
import { judgeGates } from '#kernel/gates'
import type { NodeLaneOptions } from '#kernel/lane'
import type { NodeLane } from '#kernel/lane'
import { createSessionFactory, type SessionFactory } from '#kernel/session-factory'
import { createNodeLaneRead } from '#kernel/lane-source'
import { copyManifest, createRegistry, type TypeOwnership } from '#kernel/registry'
import { assertTypeOwner, installModuleOwnership, previewModules } from '#kernel/module-install'
import { loadAllMods, publishLoadedModules } from '#mod/loader'
import { createProjector } from '#kernel/projection'
import { componentEntries } from '#kernel/migrate'
import { createNativeMountManifest } from '#kernel/mount-native'
import { ownMountTarget } from '#kernel/mount-resource'
import { createMountTable, type MountChange, type MountEntry, type MountRange, type MountTable } from '#kernel/mounts'
import { comparePositions, positionToRev } from '#kernel/position'
import { readerOperationCost, type ReaderLedger, type ReaderSource, type ReaderTarget } from '#kernel/reader'
import { drainSession } from '#kernel/session-delivery'
import { runStoreQuery } from '#kernel/store/budget'
import type { AuthReadSource, AuthSource } from '#kernel/session'
import type { AuthAdmission } from '#kernel/auth-factory'
import { DEFAULT_LIMITS, type ActionIoBinding, type AdminInput, type Budget, type ChangeMember, type Credential, type InstanceConfig, type InstanceId, type Limits, type ModuleManifest, type NodeId,
  type BlobStore, type Gate, type InstanceStream, type Node, type Path, type Position, type PositionCounter, type ProvisionedStoreMount, type Registry, type ScanRange, type Selector, type Store, type StoreCommit, type StoredNode, type StreamCursor, type StreamDomain } from '#kernel/types'
import { assertWriterDomains, createWriter, type Writer } from '#kernel/writer'
import { stableJson } from '#util/stable-json'
import { freeze } from '#util/freeze'

export interface InstanceFoundationConfig {
  readonly io?: ActionIoBinding
  readonly id: InstanceId
  readonly root: Store
  readonly writerEpoch: number
  readonly domains: readonly StreamDomain[]
  readonly counter: PositionCounter
  readonly firstAdmin?: AdminInput
  readonly budget?: () => Budget
  readonly initialCredential?: { readonly ttlMs: number }
  readonly gates?: readonly Gate[]
  readonly blobs?: BlobStore
  readonly modules?: readonly ModuleManifest[]
  readonly installerCredential?: Credential
  readonly mounts?: readonly ProvisionedStoreMount[]
}

export interface InstanceFoundation {
  readonly id: InstanceId
  readonly root: Store
  readonly registry: Registry
  readonly writer: Writer
  readonly source: AuthSource
  readonly bootstrap: BootstrapIdentity
  readonly auth?: AuthFactory
  readonly setupCredential?: Credential
  readonly stream: InstanceStream
  readonly bootstrapCursor: StreamCursor
  /** Close sessions and authentication state owned by this foundation. */
  close(): Promise<void>
  limits(): Limits
  commit(changes: readonly ChangeMember[], who: ChangeExecutor): Promise<Position>
  commands(admission: AuthAdmission): NativeCommands
  /** Supplies the same composed Store source used by native commands and lanes. */
  readerSource(allowance: Budget): ReaderSource
  /** Build lane options bound to the supplied admission. */
  nodeLaneOptions(admission: AuthAdmission): NodeLaneOptions
  /** Adopts provisioned startup resources through their exact declaring-node handlers. */
  prepareMounts(): Promise<void>
}
export interface InstanceFoundationWithAuth extends InstanceFoundation {
  readonly auth: AuthFactory
  readonly sessionFactory: SessionFactory
  /** Open a credential or anonymous session and return its lane. */
  openSession(credential?: Credential, origin?: string): Promise<NodeLane>
  /** Open a lane authorized for the supplied node path. */
  openNodeSession(path: Path): Promise<NodeLane>
}
export interface AuthInstanceFoundationConfig extends InstanceFoundationConfig { readonly initialCredential: { readonly ttlMs: number } }

/** Checks deployment identity and credential policy before module loading or storage work. */
function assertInstanceOptions(
  config: Pick<InstanceFoundationConfig, 'id' | 'writerEpoch' | 'initialCredential'>,
): void {
  if (config.id.length === 0 || !Number.isSafeInteger(config.writerEpoch) || config.writerEpoch < 0)
    throw new KernelError('INVALID', 'Invalid instance lease identity')
  if (config.initialCredential !== undefined && (!Number.isFinite(config.initialCredential.ttlMs) || config.initialCredential.ttlMs <= 0))
    throw new KernelError('INVALID', 'Credential lifetime must be positive and finite')
}

/** Composes an instance from borrowed deployment resources and publishes only owned native types. */
export async function createInstance(input: InstanceConfig): Promise<InstanceFoundationWithAuth> {
  const mounts = captureMounts(input.provisioning.mounts)
  const borrowed = new Set(input.provisioning.domains.map(domain => domain.store))
  if (input.root.kind === 'store') borrowed.add(input.root.store)
  try {
    return await buildCanonicalInstance({ ...input, provisioning: { ...input.provisioning, mounts } })
  } catch (error) {
    return closeStartupAfterFailure(mounts, borrowed, error)
  }
}

/** Capture startup ownership before the asynchronous constructor validates deployment input. */
function captureMounts(
  mounts: readonly ProvisionedStoreMount[] | undefined,
): readonly ProvisionedStoreMount[] | undefined {
  return mounts?.map(mount => Object.freeze({ ...mount, target: ownMountTarget(mount.target) }))
}

/** Preserve the construction error and every owned resource failure without closing borrowed root resources. */
async function closeStartupAfterFailure(
  mounts: readonly ProvisionedStoreMount[] | undefined,
  borrowed: ReadonlySet<Store>,
  error: unknown,
): Promise<never> {
  const closing: Promise<void>[] = []
  for (const mount of mounts ?? []) {
    if (!borrowed.has(mount.target.store)) closing.push(mount.target.close())
  }

  const closed = await Promise.allSettled(closing)
  const failures = closed.flatMap(result => {
    if (result.status === 'fulfilled') return []
    console.error(result.reason)
    return [result.reason]
  })

  if (failures.length !== 0) throw new AggregateError([error, ...failures], 'Instance construction and startup cleanup failed')
  throw error
}

/** Publishes owned modules only after the accepted root and startup inventory are initialized. */
async function buildCanonicalInstance(input: InstanceConfig): Promise<InstanceFoundationWithAuth> {
  const provisioning = input.provisioning
  const policy = provisioning.bootstrap
  const bootstrapPolicy = policy.kind === 'fresh'
    ? { kind: 'fresh' as const, admin: Object.freeze({ ...policy.admin }) }
    : {
        kind: 'reopen' as const,
        installerCredential: policy.installerCredential === undefined
          ? undefined
          : Object.freeze({ ...policy.installerCredential }),
      }
  const config = Object.freeze({
    id: input.id,
    root: Object.freeze({ ...input.root }),
    rootExternal: input.rootExternal,
    blobs: input.blobs,
    io: input.io,
    gates: input.gates === undefined ? undefined : Object.freeze([...input.gates]),
    counter: provisioning.counter,
    writerEpoch: provisioning.writerEpoch,
    domains: Object.freeze(provisioning.domains.map(domain => Object.freeze({ ...domain }))),
    mounts: provisioning.mounts?.map(mount => Object.freeze({ ...mount, target: ownMountTarget(mount.target) })),
    credentialTtlMs: provisioning.credentialTtlMs,
    bootstrapPolicy,
    modules: input.modules?.map(copyManifest),
    allowPartialMods: input.allowPartialMods,
  })

  if (config.root.kind !== 'store' || config.rootExternal !== undefined && config.rootExternal !== 'none')
    throw new KernelError('UNAVAILABLE', 'Instance root requires a supported Store target')
  assertInstanceOptions({
    id: config.id,
    writerEpoch: config.writerEpoch,
    initialCredential: { ttlMs: config.credentialTtlMs },
  })
  assertWriterDomains(config.root.store, config.domains)
  if (bootstrapPolicy.kind === 'fresh') {
    assertAdminPath(bootstrapPolicy.admin.path)
    assertAdminInput(bootstrapPolicy.admin)
  }

  const discovered = config.modules === undefined ? await loadAllMods('kernel') : undefined
  const modules = config.modules ?? discovered!.manifests.map(copyManifest)
  previewModules(modules)

  if (discovered !== undefined) {
    const preview = createRegistry()
    for (const module of bootstrapModules) preview.publish(module)
    await publishLoadedModules(preview, discovered, { allowPartialMods: config.allowPartialMods })
  }
  const instance = await createInstanceFoundation({
    id: config.id,
    root: config.root.store,
    counter: config.counter,
    writerEpoch: config.writerEpoch,
    domains: config.domains,
    mounts: config.mounts,
    blobs: config.blobs,
    io: config.io,
    gates: config.gates,
    modules,
    initialCredential: { ttlMs: config.credentialTtlMs },
    installerCredential: bootstrapPolicy.kind === 'reopen' ? bootstrapPolicy.installerCredential : undefined,
    ...(bootstrapPolicy.kind === 'fresh' ? { firstAdmin: bootstrapPolicy.admin } : {}),
  })
  try {
    const installBuiltins = bootstrapPolicy.kind === 'reopen' && bootstrapPolicy.installerCredential !== undefined
    await installModuleOwnership(
      instance,
      installBuiltins ? [...bootstrapModules, ...modules] : modules,
      bootstrapPolicy.kind === 'reopen' ? bootstrapPolicy.installerCredential : undefined,
    )
    if (installBuiltins) instance.registry.publish(createNativeMountManifest(config.writerEpoch, config.mounts))
    if (discovered === undefined) for (const module of modules) instance.registry.publish(module)
    else await publishLoadedModules(instance.registry, discovered, { allowPartialMods: config.allowPartialMods })
    await instance.prepareMounts()
    return instance
  } catch (error) {
    await instance.close()
    throw error
  }
}

/** Owns the instance's accepted Store indexes, Writer, mount routes, and session lifecycle. */
export function createInstanceFoundation(input: AuthInstanceFoundationConfig): Promise<InstanceFoundationWithAuth>
export function createInstanceFoundation(input: InstanceFoundationConfig): Promise<InstanceFoundation>
export async function createInstanceFoundation(input: InstanceFoundationConfig): Promise<InstanceFoundation> {
  const mounts = captureMounts(input.mounts)
  const borrowed = new Set([input.root, ...input.domains.map(domain => domain.store)])
  try {
    return await buildInstanceFoundation({ ...input, mounts })
  } catch (error) {
    return closeStartupAfterFailure(mounts, borrowed, error)
  }
}

/** Builds the accepted root state before exposing sessions or startup mount routes. */
async function buildInstanceFoundation(input: InstanceFoundationConfig): Promise<InstanceFoundation> {
  const { firstAdmin, domains, initialCredential, gates, modules, ...options } = input
  const config: InstanceFoundationConfig = Object.freeze({ ...options,
    domains: Object.freeze(domains.map(domain => Object.freeze({ ...domain }))),
    ...(gates === undefined ? {} : { gates: Object.freeze([...gates]) }),
    ...(modules === undefined ? {} : { modules: Object.freeze(modules.map(copyManifest)) }),
    ...(initialCredential === undefined ? {} : { initialCredential: Object.freeze({ ttlMs: initialCredential.ttlMs }) }),
    ...(firstAdmin === undefined ? {} : { firstAdmin: Object.freeze({ ...firstAdmin }) }) })
  assertInstanceOptions(config)
  assertWriterDomains(config.root, config.domains)
  if (config.firstAdmin !== undefined) {
    assertAdminPath(config.firstAdmin.path)
    assertAdminInput(config.firstAdmin)
  }

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

  let mounts: MountTable | undefined
  let sessions: SessionFactory | undefined
  const mountDeliveries = new Set<Promise<void>>()
  let constructing = true
  let closed = false
  const pendingMounts = new Map<NodeId, Node>()
  const mountTypes = new Set(['t.mount.memory', 't.mount.fs', ...config.modules?.flatMap(module =>
    module.security.flatMap(entry => entry.context === 'mount' ? [entry.type] : [])) ?? []])
  /** Keeps claimed unavailable ranges separate from the unclaimed root Store. */
  function resolveStore(path: Path): Store {
    const found = mounts?.resolve(path)
    if (found === undefined) return config.root
    if (found.target.kind !== 'store') throw new KernelError('UNAVAILABLE', 'Mount target is not a supported Store')
    return found.target.store
  }
  const targets = createAcceptedTargets(config.root, resolveStore)
  const paths = targets.root.paths
  const preparedTargets = new Map<Store, readonly StoredNode[]>()
  const preparedEntries = new Map<Store, MountEntry>()
  const registeredTargets = new Map<string, { readonly store: Store; readonly range: MountRange; readonly target: ReaderTarget }>()
  const journalOnlyStores = new Set(config.domains.map(domain => domain.store).filter(store => store !== config.root))
  const owners = new Map<string, TypeOwnership>()
  let identity: BootstrapIdentity | undefined
  let setupCredential: Credential | undefined
  let accepted = false, failure: { readonly error: unknown } | undefined
  let registryRevision = 0
  const listeners = new Set<(event: AuthEvent) => void>()
  const topologyListeners = new Set<(intersects: (range: ScanRange) => boolean) => void>()
  let topologyPosition: Position | undefined
  function notify(event: AuthEvent): void { for (const listener of listeners) listener(event) }
  const registry = createRegistry({ ownership: name => owners.get(name), published() {
    registryRevision++
    mounts?.registryChanged()
    notify({ t: 'registry' })
  } })
  const projector = createProjector({ registry, alert: (path, error) => console.error(path, error) })

  /** Rejects work after the instance fails or begins closing. */
  function available(): void {
    if (failure !== undefined) throw failure.error
    if (closed) throw new KernelError('UNAVAILABLE', 'Instance is closed')
  }
  /** Captures declaration settings only; ordinary payloads stay in their Store and bounded cache. */
  function mounting(node: StoredNode): Node | undefined {
    if (!componentEntries(node).some(([name, component]) => name === '#mount' || mountTypes.has(component.$type)
      || registry.security(component.$type, 'mount') !== undefined)) return undefined
    const { $pos, ...fields } = node
    return { ...fields, $rev: positionToRev($pos) }
  }
  /** Stages the final declarations of a whole ChangeSet before storage accepts it. */
  function mountChanges(changed: ReadonlyMap<string, StoredNode | null>): readonly MountChange[] {
    if (mounts === undefined) return []
    const changes = new Map<NodeId, MountChange>()
    for (const [path, node] of changed) {
      const old = targets.target(resolveStore(path)).paths.get(path)
      if (old !== undefined) changes.set(old, { id: old, declarations: [] })
      if (node !== null) {
        const candidate = mounting(node)
        changes.set(node.$id, candidate === undefined ? { id: node.$id, declarations: [] } : mounts.declarationsOf(candidate))
      }
    }
    return [...changes.values()]
  }
  /** Validates target identities and root invariants before accepted metadata changes. */
  function validate(changed: ReadonlyMap<string, StoredNode | null>, store = config.root): void {
    targets.validate(store, changed)
    if (mounts !== undefined) mounts.stage(mountChanges(changed))
    if (store !== config.root) return

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
    }
  }
  /** Updates a target index and, for root nodes, kernel-owned metadata. */
  function put(node: StoredNode, store = config.root): void {
    targets.put(store, node)
    if (mounts === undefined) {
      const candidate = mounting(node)
      if (candidate !== undefined) pendingMounts.set(node.$id, candidate)
      else pendingMounts.delete(node.$id)
    }
    if (store !== config.root) return
    if (node.$path.startsWith(`${TYPE_PATH}/`) || node.$type === 't.type') {
      const owner = ownershipRecord(node)
      owners.set(node.$path.slice(TYPE_PATH.length + 1), owner)
    }
    if (node.$path === LIMITS_PATH) limits = storedLimits(node)
  }
  /** Removes target metadata before the replacement images of a commit are installed. */
  function remove(path: string, store = config.root): void {
    const id = targets.target(store).paths.get(path)
    if (id !== undefined) pendingMounts.delete(id)
    targets.remove(store, path)
    if (store !== config.root) return
    if (path.startsWith(`${TYPE_PATH}/`)) owners.delete(path.slice(TYPE_PATH.length + 1))
  }
  /** Publishes one Store commit to accepted indexes and notifies its readers. */
  function publish(_domain: string, commit: StoreCommit, images: readonly Image[], store: Store): void {
    // Borrowed journal domains have no logical route; mounted Store metadata is registered separately.
    if (journalOnlyStores.has(store)) return
    if (commit.writes.length === 0) return
    try {
      const changed = new Map<string, StoredNode | null>(commit.writes.map(write => [write.path, null]))
      for (const image of images) if (image.node !== null) changed.set(image.path, image.node)
      validate(changed, store)
      const stage = mounts?.stage(mountChanges(changed))
      for (const write of commit.writes) remove(write.path, store)
      for (const image of images) if (image.node !== null) put(image.node, store)
      if (mounts !== undefined && stage !== undefined) {
        topologyPosition = commit.pos
        try { mounts.publish(stage) } finally { topologyPosition = undefined }
      }
      accepted = true
      const final = new Map<NodeId, StoredNode | null>()
      for (const image of images) if (!final.has(image.id) || image.node !== null) final.set(image.id, image.node)
      notify({ t: 'nodes', changes: [...final].map(([id, node]) => ({ id, node })) })
    } catch (error) {
      failure = { error }
      throw error
    }
  }
  const cache = createProcessCache({ queryMs: () => limits.queryMs })
  const initial = await cache.fill(config.root, { subtree: '/' }, budget())
  let writer: Writer
  try {
    for (const node of initial.nodes) put(node)
    if (storedRoot !== undefined) identity = assertBootstrapState(config.id, new Map(initial.nodes.map(node => [node.$path, node])))
    else if (paths.size !== 0) throw new KernelError('INVALID', 'Bootstrap requires an empty root Store')
    for (const module of config.modules ?? []) for (const type of module.types) for (const name of [type.name, ...type.aliases ?? []]) {
      const owner = owners.get(name)
      if (owner !== undefined) assertTypeOwner(owner, type)
      else if (storedRoot !== undefined && config.installerCredential === undefined)
        throw new KernelError('UNAUTHENTICATED', 'Module installation requires a credential')
    }
    const manifests = [
      ...bootstrapModules.map(module => module.id === 'kernel'
        ? createNativeMountManifest(config.writerEpoch, config.mounts)
        : module),
      ...config.modules ?? [],
    ]
    const startupTargets = (config.mounts ?? []).map(mount => {
      const node = pendingMounts.get(mount.node)
      const component = node === undefined ? undefined : componentEntries(node).find(([name]) => name === mount.component)?.[1]
      if (node === undefined || node.$rev !== mount.revision || component === undefined)
        throw new KernelError('CONFLICT', 'Startup mount declaration changed')
      const module = manifests.find(module =>
        module.types.some(type => type.name === component.$type || type.aliases?.includes(component.$type)))
      const type = module?.types.find(type => type.name === component.$type || type.aliases?.includes(component.$type))
      if (type === undefined || type.security === 'ordinary'
        || module!.security.every(entry => entry.type !== type.name || entry.context !== 'mount'))
        throw new KernelError('UNAVAILABLE', 'Startup mount owner handler is unavailable')
      const owner = owners.get(type.name)
      if (owner === undefined) throw new KernelError('UNAVAILABLE', 'Startup mount type is not installed')
      assertTypeOwner(owner, type)
      return { key: stableJson([mount.node, mount.component]), revision: mount.revision, target: ownMountTarget(mount.target) }
    })

    mounts = buildMountTable()
    mounts.publish(mounts.stage([...pendingMounts.values()].map(node => mounts!.declarationsOf(node))))
    pendingMounts.clear()

    const startupIdentities = new Set<NodeId>()
    for (const registration of startupTargets) {
      const scanned = await runStoreQuery(budget(), limits.queryMs,
        allowance => registration.target.store.scan({ range: { subtree: '/' }, budget: allowance }))
      targets.validateAttach(registration.target.store, scanned.items)
      for (const node of scanned.items) {
        if (startupIdentities.has(node.$id)) throw new KernelError('INVALID', 'Duplicate startup node identity')
        startupIdentities.add(node.$id)
      }
      preparedTargets.set(registration.target.store, scanned.items)
    }

    writer = await createWriter({ instance: config.id, root: config.root, writerEpoch: config.writerEpoch,
      domains: config.domains, startupTargets, counter: config.counter, budget, applied: publish, cache,
      targetLifecycle: {
        /** Checks prepared target identity before Writer publication authority is granted. */
        validate(registration) {
          if (mounts === undefined) throw new KernelError('UNAVAILABLE', 'Mount table is not initialized')
          mounts.validate(registration.key, registration.revision)
          if (registeredTargets.get(registration.key)?.store !== registration.target.store) {
            const nodes = preparedTargets.get(registration.target.store)
            if (nodes === undefined) throw new KernelError('INVALID', 'Target metadata is not prepared')
            targets.validateAttach(registration.target.store, nodes)
          }
        },
        /** Installs or removes accepted metadata as a mounted target changes routes. */
        publish(event) {
          if (mounts === undefined) throw new KernelError('UNAVAILABLE', 'Mount table is not initialized')
          if (event.kind === 'activate') {
            const nodes = preparedTargets.get(event.registration.target.store)
            const entry = preparedEntries.get(event.registration.target.store)
            if (nodes === undefined || entry === undefined) throw new KernelError('INVALID', 'Target metadata is not prepared')
            targets.attach(event.registration.target.store, nodes)
            preparedTargets.delete(event.registration.target.store)
            registeredTargets.set(entry.key, { store: event.registration.target.store, range: entry.range,
              target: { id: entry.range.generation, store: event.registration.target.store, chain: targets.chain, children: targets.children } })
            mounts.activated(event.registration.key, event.registration.revision, event.registration.target)
          } else {
            targets.detach(event.registration.target.store)
            if (registeredTargets.get(event.registration.key)?.store === event.registration.target.store)
              registeredTargets.delete(event.registration.key)
          }
        },
      } })
  } finally { initial.release() }
  constructing = false

  function reader(allowance: Budget, active = () => true, ledger?: ReaderLedger): AuthReadSource {
    const cost = ledger === undefined ? undefined : readerOperationCost(ledger)
    let nodes = 0, bytes = 0
    function check(): void {
      available()
      if (!active()) throw new KernelError('INVALID', 'Read scope has ended')
      if (Date.now() > allowance.deadline) {
        const error = new KernelError('BUDGET', 'Read deadline exceeded')
        if (cost !== undefined) cost.refuse(error)
        throw error
      }
    }
    const readSource: AuthReadSource = {
      async node(path) {
        check()
        const store = resolveStore(path)
        const id = targets.target(store).paths.get(path)
        if (id === undefined) return null
        if (nodes >= allowance.nodes) {
          const error = new KernelError('BUDGET', 'Read node budget exceeded')
          if (cost !== undefined) cost.refuse(error)
          throw error
        }
        const remaining = cost?.budget()
        if (remaining !== undefined && remaining.nodes <= 0)
          cost!.refuse(new KernelError('BUDGET', 'Read node budget exceeded'))
        const lease = await writer.cache.fill(store, { node: path }, { ...allowance,
          nodes: Math.min(allowance.nodes - nodes, remaining?.nodes ?? allowance.nodes),
          bytes: Math.min(allowance.bytes - bytes, remaining?.bytes ?? allowance.bytes) }).catch(error => {
            if (cost !== undefined) cost.refuse(error)
            throw error
          })
        try {
          check()
          const node = lease.nodes[0]
          if (node === undefined || node.$id !== id) throw new KernelError('INVALID', 'Accepted identity differs from the root Store')
          const loadedBytes = Buffer.byteLength(JSON.stringify(node))
          nodes++; bytes += loadedBytes
          cost?.charge(1, loadedBytes)
          if (nodes > allowance.nodes || bytes > allowance.bytes) {
            const error = new KernelError('BUDGET', 'Read budget exceeded')
            if (cost !== undefined) cost.refuse(error)
            throw error
          }
          return node
        } finally { lease.release() }
      },
      async nodeById(id) {
        check()
        const address = targets.address(id)
        if (address === undefined || resolveStore(address.path) !== address.store) return null
        return readSource.node(address.path)
      },
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
      return writer.read(addressedDomains(), async () => {
        try { return await run(readSource) } finally { active = false }
      })
    },
  }
  /** Quarantined startup journals participate in replay without exposing a logical read target. */
  function addressedDomains(): readonly string[] {
    return [...new Set([config.root.domain, ...[...registeredTargets.values()].map(target => target.store.domain)])]
  }
  if (storedRoot === undefined) {
    const admin = config.firstAdmin
    if (admin === undefined) throw new KernelError('INVALID', 'First-account provisioning is required')
    const result = await bootstrap({ instance: config.id, store: config.root, writer, cache: writer.cache,
      admin, budget, credentialTtlMs: config.initialCredential?.ttlMs, node: async path => reader(budget()).node(path) })
    identity = result.identity
    setupCredential = result.credential
  } else {
    accepted = true
  }
  if (identity === undefined) throw new KernelError('INVALID', 'Instance bootstrap identity is absent')
  for (const module of bootstrapModules) {
    const manifest = module.id === 'kernel' ? createNativeMountManifest(config.writerEpoch, config.mounts) : module
    // An older instance keeps optional builtins uninstalled until its admin installs their ownership.
    const installed = manifest.types.filter(type => owners.has(type.name))
    const names = new Set(installed.flatMap(type => [type.name, ...type.aliases ?? []]))
    registry.publish({ ...manifest, types: installed, security: manifest.security.filter(entry => names.has(entry.type)) })
  }

  const auth = config.initialCredential === undefined ? undefined : createAuthFactory({ instance: config.id, registry, source,
    ttlMs: config.initialCredential.ttlMs, events: { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } },
    issuer: { async issue(proof, credential) {
      await writer.commit(config.root, [], async pos => {
        const allowance = budget(), readSource = reader(allowance)
        await recheckLogin(readSource, registry, proof)
        const prepared = await prepareChangeSet({ store: config.root, cache: writer.cache, registry, limits,
          budget: allowance, readBefore: readSource.node }, [{ op: 'put', node: credential.node }], pos,
        { executor: 'kernel', caller: 'kernel' })
        validate(new Map(prepared.writes.map(write => [write.path, write.node])))
        return prepared
      })
    } } })

  async function commit(changes: readonly ChangeMember[], who: ChangeExecutor): Promise<Position> {
    available()
    if (!accepted) throw new KernelError('INVALID', 'Instance is not bootstrapped')
    return writer.commit(config.root, [], async pos => {
      const allowance = budget(), readSource = reader(allowance)
      const prepared = await prepareChangeSet({ store: config.root, cache: writer.cache, registry, limits,
        blobs: config.blobs,
        budget: allowance, readBefore: readSource.node, capabilities: { node: readSource.nodeById,
          grants: targets.grantsTo, ownerGrants: targets.ownerGrants(), shard: readSource.shard } },
      changes, pos, who)
      validate(new Map(prepared.writes.map(write => [write.path, write.node])))
      return prepared
    })
  }
  /** Opens only selector ranges before their Writer barriers; reference includes may address any target. */
  async function prepareSource(allowance: Budget, selectors: readonly Selector[], signal: AbortSignal): Promise<void> {
    available()
    if (mounts === undefined) return
    const ranges: ScanRange[] = []
    for (const selector of selectors) {
      if ('node' in selector) ranges.push({ node: selector.node })
      else if ('children' in selector) ranges.push({ children: selector.children })
      else ranges.push({ subtree: selector.history })
      const pending = 'include' in selector ? [...selector.include ?? []] : []
      for (let include = pending.pop(); include !== undefined; include = pending.pop()) {
        if ('path' in include) ranges.push({ node: include.path })
        else {
          ranges.push({ subtree: '/' })
          pending.push(...include.then ?? [])
        }
      }
    }
    await mounts.prepareRanges(ranges, allowance, signal)
    available()
  }
  /** Composes accepted target metadata and Store reads under one caller budget. */
  /** Pins source routing and read accounting to the selected operation. */
  function readerSource(allowance: Budget, ledger?: ReaderLedger): ReaderSource {
    available();
    const rootTarget: ReaderTarget = {
      id: paths.get('/')!,
      store: config.root,
      chain: targets.chain,
      children: targets.children,
    };
    /** Resolves an actual registered target while preserving its semantic generation. */
    function resolve(path: Path): ReaderTarget {
      const found = mounts?.resolve(path);
      if (found === undefined) return rootTarget;
      const registered = registeredTargets.get(found.entry.key);
      if (
        registered === undefined ||
        found.target.kind !== 'store' ||
        registered.store !== found.target.store
      )
        throw new KernelError('UNAVAILABLE', 'Mount metadata is unavailable');
      return registered.target;
    }
    /** Includes every intersecting native Store, even when the range root belongs to another target. */
    function rangeTargets(range: ScanRange): readonly ReaderTarget[] {
      const result = new Map<Store, ReaderTarget>();
      if ('node' in range) {
        const found = resolve(range.node);
        return [found];
      }
      result.set(config.root, rootTarget);
      for (const claim of mounts?.ranges(range) ?? []) {
        const registered = registeredTargets.get(claim.key);
        if (
          claim.state !== 'active' ||
          registered === undefined ||
          registered.target.id !== claim.generation
        )
          throw new KernelError('UNAVAILABLE', 'Claimed range is unavailable');
        result.set(registered.store, registered.target);
      }
      return [...result.values()];
    }
    return {
      domains: addressedDomains(),
      auth: reader(allowance, undefined, ledger),
      resolve,
      targets: rangeTargets,
      topology: (range) => (mounts === undefined ? '[]' : mounts.topology(range)),
    };
  }
  /** Binds commands to the current registry, source routing, and operation budget. */
  function commandOptions(admission: AuthAdmission): CommandOptions {
    available();
    return {
      writer,
      registry,
      projector,
      registryRevision: () => registryRevision,
      blobs: config.blobs,
      io: config.io,
      admission,
      source: readerSource,
      withNodeExecutor,
      prepareSource,
      boundary: (path) => mounts?.boundary(path) ?? false,
      capabilities: (allowance, ledger) => {
        const readSource = reader(allowance, undefined, ledger);
        return {
          node: readSource.nodeById,
          grants: targets.grantsTo,
          ownerGrants: targets.ownerGrants(),
          shard: source.shard,
        };
      },
      gates: config.gates ?? [],
      limits: () => limits,
      budget: (kind) =>
        config.budget === undefined && kind === 'action'
          ? { ...budget(), deadline: Date.now() + limits.actionMs }
          : budget(),
      validate: (prepared) =>
        validate(
          new Map(prepared.writes.map((write) => [write.path, write.node])),
          prepared.writes.length === 0 ? config.root : resolveStore(prepared.writes[0].path),
        ),
    };
  }
  /** Holds a genuine node session and pins its own configuration without requiring read grants. */
  async function withNodeExecutor<T>(
    target: NodeActionTarget,
    allowance: Budget,
    signal: AbortSignal,
    wait: <V>(pending: Promise<V>) => Promise<V>,
    run: (binding: NodeActionBinding) => Promise<T>,
    ledger?: ReaderLedger,
  ): Promise<T> {
    if (sessions === undefined)
      throw new KernelError('UNAUTHENTICATED', 'Node execution requires authentication');
    const opening = sessions.openNode(target.path, { heartbeat: false });
    let opened: Awaited<typeof opening>;
    try {
      opened = await wait(opening);
    } catch (error) {
      void opening.then(
        (late) => late.session.close(),
        (error) => console.error(error),
      );
      throw error;
    }
    let closed = false;
    /** Releases the acquired lane once, including cancellation during its callback. */
    function close(): void {
      if (closed) return;
      closed = true;
      opened.session.close();
    }
    signal.addEventListener('abort', close, { once: true });
    const delivery = drainSession(opened.session).catch((error) => {
      if (
        error instanceof KernelError &&
        (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED')
      )
        return;
      throw error;
    });
    mountDeliveries.add(delivery);
    void delivery.then(
      () => mountDeliveries.delete(delivery),
      () => mountDeliveries.delete(delivery),
    );
    try {
      signal.throwIfAborted();
      const source = readerSource(allowance, ledger);
      const owner = source.resolve(target.path);
      let settings = await wait(
        writer.read(source.domains, async () => {
          await opened.admission.validate(source.auth);
          const node = await source.auth.nodeById(target.id);
          if (
            node === null ||
            node.$path !== target.path ||
            positionToRev(node.$pos) !== target.rev
          )
            throw new KernelError('CONFLICT', 'Executor configuration changed');
          return freeze(structuredClone(node));
        }),
      );
      return await run({
        admission: opened.admission,
        options: commandOptions(opened.admission),
        get settings() {
          return settings;
        },
        /** A stream may advance its pin only with its own exact accepted image. */
        acceptOwnStep(node) {
          if (
            node.$id !== target.id ||
            node.$path !== target.path ||
            comparePositions(node.$pos, settings.$pos) <= 0
          )
            throw new KernelError('INVALID', 'Accepted executor image does not advance its pin');
          settings = freeze(structuredClone(node));
        },
        /** Rechecks admission and routed executor identity before the action can commit. */
        async validate(read) {
          await opened.admission.validate(read);
          const current = readerSource(allowance).resolve(target.path);
          const node = await read.nodeById(target.id);
          if (
            current.id !== owner.id ||
            current.store !== owner.store ||
            node === null ||
            node.$path !== target.path ||
            positionToRev(node.$pos) !== positionToRev(settings.$pos)
          )
            throw new KernelError('CONFLICT', 'Executor configuration changed');
        },
      });
    } finally {
      signal.removeEventListener('abort', close);
      close();
      await delivery;
    }
  }
  /** Build lane options with the caller's admission and instance capabilities. */
  function nodeLaneOptions(admission: AuthAdmission): NodeLaneOptions {
    const options = commandOptions(admission);
    return {
      admission,
      commands: createCommands(options),
      stream: writer.stream,
      limits: () => limits,
      intake: () => writer.intake.epoch,
      transfers:
        config.blobs === undefined ? undefined : createBlobTransfers(options, config.blobs),
      read: createNodeLaneRead(options),
      gateSub: (selector, signal) =>
        judgeGates(
          options.gates,
          { kind: 'sub', selector, origin: admission.origin },
          admission.actor,
          { signal, deadline: budget().deadline },
        ),
      registryChanged(listener) {
        const receive = (event: AuthEvent) => {
          if (event.t === 'registry') listener();
        };
        listeners.add(receive);
        return () => listeners.delete(receive);
      },
      /** Notifies lanes when a mount changes their logical topology. */
      topologyChanged(listener) {
        topologyListeners.add(listener)
        return () => topologyListeners.delete(listener)
      },
      /** Checks whether a subscription range reads from the specified Store domain. */
      domainIntersects(domain, range) {
        if (domain === config.root.domain) return true
        for (const registered of registeredTargets.values())
          if (registered.store.domain === domain && registered.range.intersects(range)) return true
        return false
      },
    };
  }
  sessions = auth === undefined ? undefined : createSessionFactory({ auth, limits: () => limits, lane: nodeLaneOptions })
  /** Stages root claims before Writer effects; handlers open after the real session factory exists. */
  function buildMountTable(): MountTable {
    return createMountTable({
      registry,
      declarationTypes: mountTypes,
      async openSession(node) {
        if (sessions === undefined) throw new KernelError('UNAUTHENTICATED', 'Mount handlers require a node session')
        const opened = await sessions.openNode(node.$path, { heartbeat: false })
        const delivery = drainSession(opened.session).catch(error => {
          // Losing the declaring node's authority ends only its owned mount session.
          if (error instanceof KernelError && (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED')) return
          throw error
        })
        mountDeliveries.add(delivery)
        void delivery.then(() => mountDeliveries.delete(delivery), error => {
          mountDeliveries.delete(delivery)
          console.error(error)
          failure = { error }
        })
        return { session: opened.session, close: () => opened.session.close() }
      },

      async activate(entry, target) {
        if (target.kind !== 'store') throw new KernelError('UNAVAILABLE', 'Mount target is not a supported Store')
        // Off-route rows must pass accepted identity checks before entering the shared cache.
        const nodes = preparedTargets.get(target.store) ?? (await runStoreQuery(budget(), limits.queryMs,
          allowance => target.store.scan({ range: { subtree: '/' }, budget: allowance }))).items
        preparedTargets.set(target.store, nodes)
        preparedEntries.set(target.store, entry)
        try {
          await writer.activateTarget({ key: entry.key, revision: entry.revision, target })
        } finally {
          preparedTargets.delete(target.store)
          preparedEntries.delete(target.store)
        }
      },

      async retire(entry) { await writer.retireTarget(entry.key, entry.revision) },
      changed(before, after) {
        if (constructing) return
        const previous = new Map(before.map(range => [range.key, range]))
        const next = new Map(after.map(range => [range.key, range]))
        const changed: MountRange[] = []
        for (const range of before) if (next.get(range.key)?.generation !== range.generation) changed.push(range)
        for (const range of after) if (previous.get(range.key)?.generation !== range.generation) changed.push(range)
        const pos = topologyPosition ?? writer.stream.cursor().pos
        // A claim can shadow root data without writing those addresses into its journal.
        writer.influence.replaceDomains(Object.keys(writer.intake.domains), pos, [config.root.domain])
        for (const listener of topologyListeners) listener(range => changed.some(claim => claim.intersects(range)))
      },

      failed(error) { console.error(error); failure = { error } },
    })
  }
  let intakeEpoch = writer.intake.epoch
  const unsubscribeIntake = writer.stream.observe(event => {
    if (event.t === 'commit' && event.record.intake !== undefined && event.record.intake.epoch !== intakeEpoch) {
      intakeEpoch = event.record.intake.epoch
      sessions?.reconnect()
    }
  })
  let closing: Promise<void> | undefined
  return {
    id: config.id,
    root: config.root,
    registry,
    writer,
    source,
    bootstrap: identity,
    stream: writer.stream,
    bootstrapCursor: writer.stream.cursor(),
    ...(auth === undefined ? {} : { auth }),
    ...(setupCredential === undefined ? {} : { setupCredential }),
    ...(sessions === undefined
      ? {}
      : {
          sessionFactory: sessions,
          openSession: async (credential?: Credential, origin?: string) =>
            (await sessions.openCredential(credential, origin)).session,
          openNodeSession: async (path: Path) => (await sessions.openNode(path)).session,
        }),
    commands: (admission) => createCommands(commandOptions(admission)),
    readerSource,
    nodeLaneOptions,
    /** Opens configured mount keys before the native runtime returns the instance. */
    async prepareMounts() {
      available()
      await mounts!.prepareKeys((config.mounts ?? []).map(mount => stableJson([mount.node, mount.component])), budget())
    },
    /** Close the sessions and authentication factory owned by this foundation. */
    close() {
      if (closing !== undefined) return closing
      closed = true
      unsubscribeIntake()
      sessions?.close()
      auth?.close()
      closing = (async () => {
        const errors: unknown[] = []
        try { await mounts!.close() } catch (error) { console.error(error); errors.push(error) }
        try { await writer.closeTargets() } catch (error) { console.error(error); errors.push(error) }
        const drained = await Promise.allSettled(mountDeliveries)
        for (const result of drained) if (result.status === 'rejected') errors.push(result.reason)
        if (errors.length !== 0) throw new AggregateError(errors, 'Instance resources failed to close')
      })()
      return closing
    },
    limits() {
      available();
      return limits;
    },
    commit,
  }
}
