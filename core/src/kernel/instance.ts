import { ancestorPaths } from '#core/path'
import { ACTION_PUBLICATION_PREFIX, installPublishedAction, publishedAction, actionPublicationPath } from '#kernel/action-publication'
import { verifyActionSource } from '#kernel/source-action'
import { installPublishedView, publishedView, PUBLICATION_PREFIX } from '#kernel/uix-publication'
import { withTypeDescriptions } from '#kernel/type-description'
import { selectionOwnership } from '#kernel/lane-selection'
import { createForeignSubscription } from '#kernel/authority/subscription'
import { runFederationCommit } from '#kernel/authority/commit'
import { runFederationAction } from '#kernel/authority/action'
import { createAuthorityNamespace } from '#kernel/authority/namespace'
import { createFederationOwner } from '#kernel/authority/owner'
import { createShardOwner } from '#kernel/authority/shard-owner'
import { createShardRelay } from '#kernel/authority/shard-relay'
import { runShardCommit, runShardAction } from '#kernel/authority/shard-mutation'
import { observeCredential } from '#kernel/authority/credential-watch'
import { serializeKernel } from '#kernel/serialization'
import type { RawFsCodecs } from '#kernel/store/rawfs-codec'
import { comparePaths } from '#core/path'
import { KernelError } from '#errors'
import { createAutostartHandler, createInstanceServices, serviceConfiguration, type ServiceBootstrapPorts, type ServiceTarget } from '#kernel/services'
import { AUTH_KEY_PATH, assertAdminInput } from '#kernel/auth-module'
import { createAuthFactory, type AuthEvent, type AuthFactory } from '#kernel/auth-factory'
import { recheckLogin } from '#kernel/auth/login'
import { assertAdminPath, assertAuthKey, assertBootstrapState, bootstrap, bootstrapIdentity, bootstrapModules, LIMITS_PATH, ownershipRecord, storedLimits, TYPE_PATH, type BootstrapIdentity } from '#kernel/bootstrap'
import { createProcessCache, type Image } from '#kernel/cache'
import { createBlobTransfers } from '#kernel/blobs'
import { createAcceptedTargets } from '#kernel/instance-targets'
import { decodeChainNode } from '#kernel/chain-index'
import { changeSelectors, prepareChangeSet, type ChangeExecutor } from '#kernel/changeset'
import { type AcceptedTargetReplacement } from '#kernel/instance-targets'
import { runBackfill } from '#kernel/backfill'
import { createCommands, type CommandOptions, type NativeCommands, type NodeActionBinding, type NodeActionTarget } from '#kernel/commands'
import { judgeGates } from '#kernel/gates'
import type { NodeLaneOptions } from '#kernel/lane'
import type { NodeLane } from '#kernel/lane'
import { createSessionFactory, type OpenedSession, type SessionFactory } from '#kernel/session-factory'
import { createNodeLaneRead } from '#kernel/lane-source'
import { copyManifest, createRegistry, type TypeOwnership } from '#kernel/registry'
import { assertTypeOwner, installModuleOwnership, previewModules } from '#kernel/module-install'
import { bindModuleIo, loadAllMods, publishLoadedModules } from '#mod/loader'
import { createGuard } from '#kernel/guard'
import { createProjector, visibleNode } from '#kernel/projection'
import { componentEntries } from '#kernel/migrate'
import { createNativeMountManifest } from '#kernel/mount-native'
import type { FsDirectoryBindings } from '#kernel/mount-fs-provider'
import { ownMountTarget } from '#kernel/mount-resource'
import { createMountTable, type MountChange, type MountEntry, type MountRange, type MountStage, type MountTable, type PreparedMountReplacement } from '#kernel/mounts'
import { transferSubtree as runSubtreeTransfer, type SubtreeTransfer } from '#kernel/transfer'
import { readTransferProvenance, reopenTransferSource, type ReopenedTransferSource } from '#kernel/transfer-provenance'
import { createStoreBindingOwner } from '#kernel/store-binding'
import { createStoreChangeMapping } from '#kernel/store-binding-change'
import { comparePositions, positionToRev } from '#kernel/position'
import { createReader, createReaderLedger, readerOperationCost, type ReaderBindingScope, type ReaderLedger, type ReaderSource, type ReaderTarget } from '#kernel/reader'
import { computeAdmittedRights, computeRights, type ChainNode } from '#kernel/rights'
import { createView, type ViewRead } from '#kernel/view'
import { createActionControl } from '#kernel/action-context'
import { drainSession } from '#kernel/session-delivery'
import { runStoreQuery } from '#kernel/store/budget'
import type { ShardConnection, ShardEnvelope } from '#kernel/types'
import type { AuthReadSource, AuthSource } from '#kernel/session'
import type { AuthAdmission } from '#kernel/auth-factory'
import { A, R, W, DEFAULT_LIMITS, type FederationBinding, type ActionIoBinding, type AdminInput, type InstallerLogin, type Budget, type ChangeMember, type Credential, type InstanceConfig, type ExternalEdits, type InstanceId, type Limits, type ModuleManifest, type NodeId, type BlobStore, type Gate, type InstanceStream, type Node, type Path, type Position, type PositionCounter, type ProvisionedStoreMount, type Registry, type ScanRange, type Selector, type SubSelector, type Store, type StoreCommit, type StoredNode, type StreamCursor, type StreamDomain } from '#kernel/types'
import type { StoreCommitGroup } from '#kernel/types'
import type { OpenedStoreMountTarget } from '#kernel/types'
import { assertWriterDomains, createWriter, type Writer } from '#kernel/writer'
import { combineReadSets } from '#kernel/preconditions'
import { stableJson } from '#util/stable-json'
import { freeze } from '#util/freeze'
interface PreparedTransferRoute {
  readonly replacement: PreparedMountReplacement
  readonly source: AcceptedTargetReplacement
  readonly target: OpenedStoreMountTarget
  stage: MountStage
  revision: string
  entry?: MountEntry
  pos?: Position
  installed: boolean
}
interface BoundTransferRoute extends PreparedTransferRoute {
  readonly entry: MountEntry
  readonly pos: Position
}

export interface InstanceFoundationConfig {
  readonly federation?: FederationBinding
  readonly shardPath?: Path
  readonly rawfsCodecs?: RawFsCodecs
  readonly mountDirectories?: FsDirectoryBindings
  readonly io?: ActionIoBinding
  readonly id: InstanceId
  readonly root: Store
  readonly rootExternal?: ExternalEdits
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
  readonly installerLogin?: InstallerLogin
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
  /** Kernel-owned physical transfer; ordinary Session mutations cannot invoke it. */
  transferSubtree(input: SubtreeTransfer): Promise<Position>
  commands(admission: AuthAdmission): NativeCommands
  /** Supplies the same composed Store source used by native commands and lanes. */
  readerSource(allowance: Budget): ReaderSource
  /** Build lane options bound to the supplied admission. */
  nodeLaneOptions(admission: AuthAdmission): NodeLaneOptions
  /** Adopts provisioned startup resources through their exact declaring-node handlers. */
  prepareMounts(): Promise<void>
  bindAutostartModule(module: ModuleManifest): ModuleManifest
  prepareServices(): Promise<void>
  preparePublications(): Promise<void>
}
export interface InstanceFoundationWithAuth extends InstanceFoundation {
  readonly auth: AuthFactory
  readonly sessionFactory: SessionFactory
  /** Open a credential or anonymous session and return its lane. */
  openSession(credential?: Credential, origin?: string): Promise<NodeLane>
  /** Open a lane authorized for the supplied node path. */
  openNodeSession(path: Path): Promise<NodeLane>
  /** Trusted deployment transport opens this same-zone receiver with a Writer-owned envelope. */
  openShard(envelope: ShardEnvelope, signal?: AbortSignal): Promise<ShardConnection>
}
/** Install deployment-owned state before mount preparation and service admission. */
export type InstanceInitializer = (instance: InstanceFoundationWithAuth) => Promise<void>

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
export async function createInstance(input: InstanceConfig, initialize?: InstanceInitializer): Promise<InstanceFoundationWithAuth> {
  const mounts = captureMounts(input.provisioning.mounts)
  const borrowed = new Set(input.provisioning.domains.map(domain => domain.store))
  if (input.root.kind === 'store') borrowed.add(input.root.store)
  try {
    return await buildCanonicalInstance({ ...input, provisioning: { ...input.provisioning, mounts } }, initialize)
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
async function buildCanonicalInstance(input: InstanceConfig, initialize?: InstanceInitializer): Promise<InstanceFoundationWithAuth> {
  const provisioning = input.provisioning
  const policy = provisioning.bootstrap
  const bootstrapPolicy = policy.kind === 'fresh'
    ? { kind: 'fresh' as const, admin: Object.freeze({ ...policy.admin }) }
    : {
        kind: 'reopen' as const,
        installerLogin: policy.installerLogin === undefined ? undefined : Object.freeze({ ...policy.installerLogin }),
        installerCredential: policy.installerCredential === undefined
          ? undefined
          : Object.freeze({ ...policy.installerCredential }),
      }
  const config = Object.freeze({
    id: input.id,
    federation: input.federation,
    shardPath: input.shardPath,
    root: Object.freeze({ ...input.root }),
    rootExternal: input.rootExternal,
    blobs: input.blobs,
    io: input.io,
    rawfsCodecs: Object.freeze({ ...input.rawfsCodecs }),
    mountDirectories: Object.freeze({ ...input.mountDirectories }),
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

  if (config.root.kind !== 'store')
    throw new KernelError('UNAVAILABLE', 'Instance root requires a supported Store target')
  if (config.rootExternal === 'trusted' && (config.root.store.external === undefined || config.root.store.readExternal === undefined))
    throw new KernelError('INVALID', 'Trusted root Store must report and read external edits')
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
  const ioBindings: ActionIoBinding[] = []
  if (discovered?.io !== undefined) ioBindings.push(discovered.io)
  if (config.io !== undefined) ioBindings.push(config.io)
  const io = bindModuleIo(ioBindings)
  const gates = [...(discovered?.gates ?? []), ...(config.gates ?? [])]

  if (discovered !== undefined) {
    const preview = createRegistry()
    for (const module of bootstrapModules) preview.publish(module)
    await publishLoadedModules(preview, discovered, { allowPartialMods: config.allowPartialMods })
  }
  const instance = await createInstanceFoundation({
    id: config.id,
    root: config.root.store,
    rootExternal: config.rootExternal,
    counter: config.counter,
    writerEpoch: config.writerEpoch,
    domains: config.domains,
    mounts: config.mounts,
    federation: config.federation,
    shardPath: config.shardPath,
    rawfsCodecs: config.rawfsCodecs,
    mountDirectories: config.mountDirectories,
    blobs: config.blobs,
    io,
    gates,
    modules,
    initialCredential: { ttlMs: config.credentialTtlMs },
    installerCredential: bootstrapPolicy.kind === 'reopen' ? bootstrapPolicy.installerCredential : undefined,
    installerLogin: bootstrapPolicy.kind === 'reopen' ? bootstrapPolicy.installerLogin : undefined,
    ...(bootstrapPolicy.kind === 'fresh' ? { firstAdmin: bootstrapPolicy.admin } : {}),
  })
  try {
    const installBuiltins = bootstrapPolicy.kind === 'reopen' && (bootstrapPolicy.installerCredential !== undefined || instance.setupCredential !== undefined)
    await installModuleOwnership(
      instance,
      installBuiltins ? [...bootstrapModules, ...modules] : modules,
      bootstrapPolicy.kind === 'reopen' ? bootstrapPolicy.installerCredential : undefined,
    )
    if (installBuiltins) instance.registry.publish(withTypeDescriptions(createNativeMountManifest(config.writerEpoch, config.mounts, instance.limits, config.federation, { instance: config.id, directories: config.mountDirectories ?? {}, rawfsCodecs: config.rawfsCodecs }), instance.registry))
    if (discovered === undefined) for (const module of modules) instance.registry.publish(instance.bindAutostartModule(module))
    else await publishLoadedModules(instance.registry, { ...discovered, manifests: discovered.manifests.map(module => ({
      ...module, ...instance.bindAutostartModule(module),
    })) }, { allowPartialMods: config.allowPartialMods })
    await initialize?.(instance)
    await instance.preparePublications()
    await instance.prepareMounts()
    await instance.preparePublications()
    await instance.prepareServices()
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
  const { firstAdmin, installerLogin, domains, initialCredential, gates, modules, ...options } = input
  const config: InstanceFoundationConfig = Object.freeze({ ...options,
    domains: Object.freeze(domains.map(domain => Object.freeze({ ...domain }))),
    ...(gates === undefined ? {} : { gates: Object.freeze([...gates]) }),
    ...(modules === undefined ? {} : { modules: Object.freeze(modules.map(copyManifest)) }),
    ...(initialCredential === undefined ? {} : { initialCredential: Object.freeze({ ttlMs: initialCredential.ttlMs }) }),
    ...(firstAdmin === undefined ? {} : { firstAdmin: Object.freeze({ ...firstAdmin }) }),
    ...(installerLogin === undefined ? {} : { installerLogin: Object.freeze({ ...installerLogin }) }) })
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
  if (config.root.storageFault?.('/') !== undefined)
    throw new KernelError('INVALID', 'An unreadable root cannot be bootstrapped')
  if (storedRoot !== undefined) {
    bootstrapIdentity(storedRoot, config.id)
    const key = (await config.root.scan({ range: { node: AUTH_KEY_PATH }, budget: budget() })).items[0]
    assertAuthKey(key ?? null, config.id)
    if (config.firstAdmin !== undefined) throw new KernelError('INVALID', 'First-account provisioning requires an empty instance')
  } else if (config.firstAdmin === undefined) throw new KernelError('INVALID', 'First-account provisioning is required')

  let mounts: MountTable | undefined
  let sessions: SessionFactory | undefined
  const mountDeliveries = new Set<Promise<void>>()
  const shardOwners = new Map<string, ReturnType<typeof createShardOwner> & { readonly path: Path }>()
  const authorityOwners = new Map<string, ReturnType<typeof createFederationOwner> & { readonly path: Path; readonly namespace: ReturnType<typeof createAuthorityNamespace> }>()
  const viewOwners = new Map<string, { readonly view: ReturnType<typeof createView>; readonly close: () => void }>()
  let constructing = true
  let closed = false
  const pendingMounts = new Map<NodeId, Node>()
  const mountTypes = new Set(['t.mount.memory', 't.mount.fs', 't.mount.query', ...config.modules?.flatMap(module =>
    module.security.flatMap(entry => entry.context === 'mount' ? [entry.type] : [])) ?? []])
  /** Keeps claimed unavailable ranges separate from the unclaimed root Store. */
  function resolveStore(path: Path): Store {
    const found = mounts?.resolve(path)
    if (found === undefined) return config.root
    if (found.target.kind === 'view') throw new KernelError('READ_ONLY', 'A View has no writable Store')
    if (found.target.kind !== 'store') throw new KernelError('UNAVAILABLE', 'Mount target is not a supported Store')
    return found.target.store
  }
  const targets = createAcceptedTargets(config.root, resolveStore, (store, path, id) => {
    if (!externalStore(store)) return undefined
    const image = cache.getAt(store, path) ?? (id === undefined ? undefined : cache.get(id))
    return image?.node
  })
  const paths = targets.root.paths
  const preparedTargets = new Map<Store, ReturnType<typeof targets.prepare>>()
  const preparedEntries = new Map<Store, MountEntry>()
  const preparedTransferSources = new Map<Store, ReopenedTransferSource>()
  const transferRoutes = new Map<Store, PreparedTransferRoute>()
  const transferPublications = new Map<string, BoundTransferRoute>()
  const preparedTransferOwners = new Set<PreparedMountReplacement>()
  const registeredTargets = new Map<string, { readonly store: Store; readonly range: MountRange; readonly target: ReaderTarget }>()
  const backfills = new Map<Store, Promise<void>>()
  let backfillReady = false
  const storeBindings = new Map<OpenedStoreMountTarget, { readonly entry: MountEntry; readonly source: ReturnType<typeof createStoreBindingOwner>; stop?: () => void }>()
  function bindingAt(path: Path, children = false) {
    if (storeBindings.size === 0) return undefined
    const found = mounts?.resolve(path, children)
    if (found?.target.kind !== 'store') return undefined
    const binding = storeBindings.get(found.target)
    return binding === undefined ? undefined : { ...binding, target: found.target }
  }

  function bindingTarget(binding: NonNullable<ReturnType<typeof bindingAt>>): ReaderTarget {
    const root = binding.source.binding.path
    return { id: binding.entry.revision, store: binding.target.store,
      chain(path) {
        const result: ChainNode[] = root === binding.entry.node.$path
          ? [...targets.chain(root).filter(node => node.path !== root), decodeChainNode(binding.entry.node)]
          : [...targets.chain(root)]
        for (const ancestor of ancestorPaths(path)) {
          if (ancestor !== root && !ancestor.startsWith(`${root === '/' ? '' : root}/`)) continue
          const upper = binding.source.metadata(ancestor)
          if (upper === null) continue
          let future = upper
          if (future === undefined) {
            const physical = binding.source.sources(ancestor, root).lower
            const lower = targets.chain(physical).find(node => node.path === physical)
            if (lower !== undefined) future = lower.invalid === 'chain'
              ? { ...lower, path: ancestor, acl: [], hasAcl: false, hasOwner: false, owner: undefined }
              : { ...lower, path: ancestor, id: binding.source.identity.id(lower.id),
                acl: [], hasAcl: false, hasOwner: false, owner: undefined }
          }
          if (future === undefined) continue
          if (ancestor === root) {
            const declaration = result.find(node => node.path === root)
            if (declaration !== undefined) {
              result.splice(result.indexOf(declaration), 1, { ...declaration,
                types: [...new Set([...declaration.types, ...future.types])] })
              continue
            }
          }
          result.push(future)
        }
        return result
      },
      children() { return [] },
    }
  }

  const journalOnlyStores = new Set(config.domains.map(domain => domain.store).filter(store => store !== config.root))
  const owners = new Map<string, TypeOwnership>()
  let identity: BootstrapIdentity | undefined
  let setupCredential: Credential | undefined
  let installationRequired = false

  /** Install physical-owner metadata before the accepted route can be observed. */
  function installTarget(entry: MountEntry, target: OpenedStoreMountTarget,
    nodes: ReturnType<typeof targets.prepare>, replacement?: AcceptedTargetReplacement): void {
    targets.attach(nodes, replacement)
    if (replacement !== undefined) cache.retireStore(replacement.store)
    preparedTargets.delete(target.store)
    registeredTargets.set(entry.key, { store: target.store, range: entry.range,
      target: { id: entry.range.generation, store: target.store, external: entry.declaration.external,
        chain: targets.chain, children: targets.children } })
  }
  let accepted = storedRoot !== undefined, failure: { readonly error: unknown } | undefined
  let registryRevision = 0
  const listeners = new Set<(event: AuthEvent) => void>()
  const topologyListeners = new Set<(intersects: (range: ScanRange) => boolean) => void>()
  let topologyPosition: Position | undefined
  function notify(event: AuthEvent): void { for (const listener of listeners) listener(event) }
  const registry = createRegistry({ ownership: name => owners.get(name), published() {
    registryRevision++
    mounts?.registryChanged()
    notify({ t: 'registry' })
    if (backfillReady) {
      queueBackfill(config.root)
      for (const target of registeredTargets.values()) queueBackfill(target.store)
    }
  } })
  const projector = createProjector({ registry, alert: (path, error) => console.error(path, error) })

  /** Rejects work after the instance fails or begins closing. */
  function available(): void {
    if (failure !== undefined) throw failure.error
    if (closed) throw new KernelError('UNAVAILABLE', 'Instance is closed')
  }
  /** Captures declaration settings only; ordinary payloads stay in their Store and bounded cache. */
  function mounting(node: StoredNode, external = false): Node | undefined {
    if (!Object.hasOwn(node, '#mount')) {
      try {
        if (!componentEntries(node).some(([name, component]) => name === '#mount' || mountTypes.has(component.$type)
          || registry.security(component.$type, 'mount') !== undefined)) return undefined
      } catch (error) {
        if (!external || !(error instanceof KernelError) || error.code !== 'INVALID') throw error
      }
    }
    const { $pos, ...fields } = node
    return { ...fields, $rev: positionToRev($pos) }
  }
  /** Stages the final declarations of a whole ChangeSet before storage accepts it. */
  function mountChanges(changed: ReadonlyMap<string, StoredNode | null>, external = false): readonly MountChange[] {
    if (mounts === undefined) return []
    const changes = new Map<NodeId, MountChange>()
    for (const [path, node] of changed) {
      const old = targets.target(resolveStore(path)).paths.get(path)
      if (old !== undefined) changes.set(old, { id: old, declarations: [] })
      if (node !== null) {
        const candidate = mounting(node, external)
        changes.set(node.$id, candidate === undefined ? { id: node.$id, declarations: [] } : mounts.declarationsOf(candidate, external))
      }
    }
    return [...changes.values()]
  }
  /** Validates target identities and root invariants before accepted metadata changes. */
  function validate(changed: ReadonlyMap<string, StoredNode | null>, store = config.root, external = false, grouped = false): void {
    if (!grouped) targets.validate(store, changed)
    if (mounts !== undefined) mounts.stage(mountChanges(changed, external))
    if (store !== config.root) return

    for (const [path, node] of changed) {
      if (node === null && path.startsWith(ACTION_PUBLICATION_PREFIX))
        throw new KernelError('FORBIDDEN', 'Accepted action publication is required')
      if (node?.$type === 'uix.action-publication') {
        const source = publishedAction(node)
        if (registry.type(source.type).module !== source.module)
          throw new KernelError('FORBIDDEN', 'Action publication differs from type ownership')
        registry.module(source.module)
        if (source.stream && source.definition.kind !== 'read' && source.definition.post !== undefined)
          throw new KernelError('INVALID', 'Streaming action source cannot declare post')
      }
    }

    for (const node of changed.values()) if (node?.$type === 'uix.publication') {
      const view = publishedView(node)
      if (registry.type(view.type).module !== view.module)
        throw new KernelError('FORBIDDEN', 'Publication differs from type ownership')
      registry.module(view.module)
    }

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
      const candidate = mounting(node, config.rootExternal === 'trusted')
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
    if (commit.writes.length === 0 && !commit.record.quarantine?.length) return
    try {
      const changed = new Map<string, StoredNode | null>(commit.writes.map(write => [write.path, null]))
      for (const image of images) if (image.node !== null) changed.set(image.path, image.node)
      const external = commit.record.executor.startsWith('external:')
      validate(changed, store, external)
      const claims = new Map(mountChanges(changed, external).map(change => [change.id, change]))
      for (const fault of mounts?.faultChanges((commit.record.quarantine ?? []).filter(change => change.fault !== null).map(change => change.path)) ?? [])
        claims.set(fault.id, fault)
      const transferred = transferPublications.get(positionToRev(commit.pos))
      const stage = transferred?.stage ?? mounts?.stage([...claims.values()])
      if (transferred !== undefined) {
        const nodes = preparedTargets.get(transferred.target.store)
        if (nodes === undefined) throw new KernelError('INVALID', 'Transfer metadata is not prepared')
        installTarget(transferred.entry, transferred.target, nodes, transferred.source)
        transferred.installed = true
      }
      for (const write of commit.writes) remove(write.path, store)
      for (const image of images) if (image.node !== null) put(image.node, store)
      if (mounts !== undefined && stage !== undefined) {
        topologyPosition = commit.pos
        try {
          if (transferred === undefined) mounts.publish(stage)
          else transferred.replacement.publish(stage)
        } finally { topologyPosition = undefined }
      }
      accepted = true
      for (const image of images) if (image.node?.$type === 'uix.publication')
        installPublishedView(registry, publishedView(image.node))
      for (const image of images) if (image.node?.$type === 'uix.action-publication')
        installPublishedAction(registry, publishedAction(image.node))
      const final = new Map<NodeId, StoredNode | null>()
      for (const image of images) if (!final.has(image.id) || image.node !== null) final.set(image.id, image.node)
      if (commit.record.quarantine !== undefined) notify({ t: 'faults', changes: commit.record.quarantine })
      notify({ t: 'nodes', changes: [...final].map(([id, node]) => ({ id, node })) })
    } catch (error) {
      failure = { error }
      throw error
    }
  }

  /** Stages all metadata together; persistence must succeed before the returned publication runs. */
  function stageGroups(commit: StoreCommit, groups: readonly StoreCommitGroup[]): () => void {
    targets.validateGroups(groups)
    const external = commit.record.executor.startsWith('external:')
    const changed = new Map(commit.writes.map(write => [write.path, write.node]))
    for (const group of groups)
      validate(new Map(group.writes.map(write => [write.path, write.node])), group.store, external, true)
    const claims = new Map(mountChanges(changed, external).map(change => [change.id, change]))
    for (const fault of mounts?.faultChanges((commit.record.quarantine ?? []).filter(change => change.fault !== null).map(change => change.path)) ?? [])
      claims.set(fault.id, fault)
    const stage = mounts?.stage([...claims.values()])
    const final = new Map<NodeId, StoredNode | null>()
    for (const entry of commit.record.entries) final.set(entry.id, null)
    for (const write of commit.writes) if (write.node !== null) final.set(write.node.$id, write.node)

    return () => {
      for (const group of groups) for (const write of group.writes) remove(write.path, group.store)
      for (const group of groups) for (const write of group.writes) if (write.node !== null) put(write.node, group.store)
      if (mounts !== undefined && stage !== undefined) {
        topologyPosition = commit.pos
        try { mounts.publish(stage) } finally { topologyPosition = undefined }
      }
      accepted = true
      if (commit.record.quarantine !== undefined) notify({ t: 'faults', changes: commit.record.quarantine })
      notify({ t: 'nodes', changes: [...final].map(([id, node]) => ({ id, node })) })
    }
  }
  /** Active declarations decide freshness; advertising a reporter alone does not enable external edits. */
  function externalStore(store: Store): boolean {
    if (store === config.root) return config.rootExternal === 'trusted'
    const prepared = preparedEntries.get(store)
    if (prepared !== undefined) return prepared.declaration.external === 'trusted'
    for (const registered of registeredTargets.values())
      if (registered.store === store) return registered.target.external === 'trusted'
    return false
  }
  const cache = createProcessCache({ queryMs: () => limits.queryMs, external: externalStore })
  const initial = await cache.fill(config.root, { subtree: '/' }, budget())
  let writer: Writer
  /** Migration batches release Writer barriers and retain native owner authority per accepted step. */
  function queueBackfill(store: Store): void {
    if (!backfillReady || store.backfill === undefined || backfills.has(store)) return
    const active = () => !closed && (store === config.root || config.domains.some(domain => domain.store === store)
      || [...registeredTargets.values()].some(target => target.store === store))
    const task = (async () => {
      while (active()) {
        try {
          const generation = registry.digest
          await runBackfill({ writer, store, registry, limits: () => limits, budget, active })
          if (registry.digest === generation) return
        }
        catch (error) {
          console.error(error)
          if (!active()) return
          if (!(error instanceof KernelError) || error.code !== 'CONFLICT') throw error
        }
      }
    })().catch(error => { failure = { error }; console.error(error) }).finally(() => { backfills.delete(store) })
    backfills.set(store, task)
  }
  try {
    for (const node of initial.nodes) put(node)
    if (storedRoot !== undefined) identity = assertBootstrapState(config.id, new Map(initial.nodes.map(node => [node.$path, node])))
    else if (paths.size !== 0) throw new KernelError('INVALID', 'Bootstrap requires an empty root Store')
    for (const module of config.modules ?? []) for (const type of module.types) for (const name of [type.name, ...type.aliases ?? []]) {
      const owner = owners.get(name)
      if (owner !== undefined) assertTypeOwner(owner, type)
      else {
        installationRequired = true
        if (storedRoot !== undefined && config.installerCredential === undefined
          && (config.installerLogin === undefined || config.initialCredential === undefined))
          throw new KernelError('UNAUTHENTICATED', 'Module installation requires a credential')
      }
    }
    const manifests = [
      ...bootstrapModules.map(module => module.id === 'kernel'
        ? withTypeDescriptions(createNativeMountManifest(config.writerEpoch, config.mounts, () => limits, config.federation, { instance: config.id, directories: config.mountDirectories ?? {}, rawfsCodecs: config.rawfsCodecs }), registry)
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
    mounts.publish(mounts.stage([...pendingMounts.values()].map(node => mounts!.declarationsOf(node, config.rootExternal === 'trusted'))))
    pendingMounts.clear()

    const startupIdentities = new Set<NodeId>()
    for (const registration of startupTargets) {
      const entry = mounts.declaration(registration.key)
      const proof = await readTransferProvenance(config.root, registration.target.store.blobOwner, budget())
      if (proof?.intent.source === config.root.blobOwner) {
        const recovered = await reopenTransferSource(config.root, config.writerEpoch, entry,
          registration.target, mounts, registry, budget())
        if (recovered === undefined) throw new KernelError('CONFLICT', 'Startup transfer ownership changed')
        preparedTransferSources.set(registration.target.store, recovered)
      }
      const scanned = await runStoreQuery(budget(), limits.queryMs,
        allowance => registration.target.store.scan({ range: { census: '/' }, budget: allowance }))
      const prepared = targets.prepare(registration.target.store, scanned.items,
        preparedTransferSources.get(registration.target.store)?.replacement)
      for (const node of scanned.items) {
        if (startupIdentities.has(node.$id)) throw new KernelError('INVALID', 'Duplicate startup node identity')
        startupIdentities.add(node.$id)
      }
      preparedTargets.set(registration.target.store, prepared)
    }

    writer = await createWriter({ instance: config.id, root: config.root, blobs: config.blobs, writerEpoch: config.writerEpoch,
      domains: config.domains, startupTargets, counter: config.counter, budget, applied: publish, stageApplied: stageGroups, cache,
      maintenance: { retentionMs: () => limits.journalRetentionMs, changeSet: () => limits.changeSet,
        orphanMs: () => limits.blobOrphanMs },
      targetLifecycle: {
        /** Checks prepared target identity before Writer publication authority is granted. */
        validate(registration) {
          if (mounts === undefined) throw new KernelError('UNAVAILABLE', 'Mount table is not initialized')
          const transferred = transferRoutes.get(registration.target.store)
          if (transferred === undefined) mounts.validate(registration.key, registration.revision)
          else {
            transferred.replacement.validate(transferred.stage)
            if (registration.key !== transferred.replacement.entry.key || registration.revision !== transferred.revision)
              throw new KernelError('CONFLICT', 'Prepared transfer declaration changed')
          }
          if (registeredTargets.get(registration.key)?.store !== registration.target.store) {
            const nodes = preparedTargets.get(registration.target.store)
            if (nodes === undefined) throw new KernelError('INVALID', 'Target metadata is not prepared')
            targets.validateAttach(nodes, transferred?.source ?? preparedTransferSources.get(registration.target.store)?.replacement)
          }
        },
        /** Installs or removes accepted metadata as a mounted target changes routes. */
        publish(event) {
          if (mounts === undefined) throw new KernelError('UNAVAILABLE', 'Mount table is not initialized')
          if (event.kind === 'activate') {
            const transferred = transferRoutes.get(event.registration.target.store)
            if (transferred !== undefined) {
              if (!transferred.installed) throw new KernelError('INVALID', 'Transfer route was not published')
              mounts.activated(event.registration.key, event.registration.revision, event.registration.target)
              transferPublications.delete(positionToRev(event.pos))
              transferRoutes.delete(event.registration.target.store)
              return
            }
            const nodes = preparedTargets.get(event.registration.target.store)
            const entry = preparedEntries.get(event.registration.target.store)
            if (nodes === undefined || entry === undefined) throw new KernelError('INVALID', 'Target metadata is not prepared')
            installTarget(entry, event.registration.target, nodes, preparedTransferSources.get(event.registration.target.store)?.replacement)
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
  const externalOwners = new Map<Store, { readonly control: AbortController; readonly done: Promise<void> }>()

  function reader(allowance: Budget, active = () => true, ledger?: ReaderLedger): AuthReadSource {
    const cost = ledger === undefined ? undefined : readerOperationCost(ledger)
    let nodes = 0, bytes = 0, exprWork = 0
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
        const binding = bindingAt(path)
        if (binding !== undefined) {
          const physical = binding.source.sources(path, binding.source.binding.path)
          const upper = await readSource.node(physical.upper)
          let lower = await readSource.node(physical.lower)
          const selected = binding.source.select({ lower, upper })
          if (selected?.baseId !== null && selected?.baseId !== undefined && lower?.$id !== selected.baseId) {
            const address = targets.address(selected.baseId), root = binding.source.binding.lower
            if (address === undefined || address.path !== root && !address.path.startsWith(`${root === '/' ? '' : root}/`))
              throw new KernelError('NOT_FOUND', 'Store binding lower identity left its declared range')
            lower = await readSource.node(address.path)
          }
          check()
          if (bindingAt(path)?.target !== binding.target)
            throw new KernelError('CONFLICT', 'Store binding declaration changed')
          const node = binding.source.project(path, { lower, upper })
          if (node !== null) {
            const work = Buffer.byteLength(serializeKernel(node))
            bytes += work
            exprWork += Math.ceil(work / 8)
            cost?.charge(0, work, Math.ceil(work / 8))
            if (bytes > allowance.bytes || exprWork > allowance.exprWork)
              throw new KernelError('BUDGET', 'Read projection budget exceeded')
          }
          return node
        }
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
          bytes: Math.min(allowance.bytes - bytes, remaining?.bytes ?? allowance.bytes),
          exprWork: Math.min(allowance.exprWork - exprWork, remaining?.exprWork ?? allowance.exprWork) }).catch(error => {
            if (cost !== undefined) cost.refuse(error)
            throw error
          })
        try {
          check()
          const node = lease.nodes[0]
          if (externalStore(store)) {
            if (lease.cost === undefined) throw new KernelError('INVALID', 'Trusted physical read has no inspected cost')
            nodes += lease.cost.nodes; bytes += lease.cost.bytes; exprWork += lease.cost.exprWork
            cost?.charge(lease.cost.nodes, lease.cost.bytes, lease.cost.exprWork)
          } else {
            if (node === undefined || node.$id !== id) throw new KernelError('INVALID', 'Accepted identity differs from the root Store')
            const loadedBytes = Buffer.byteLength(JSON.stringify(node))
            nodes++; bytes += loadedBytes
            cost?.charge(1, loadedBytes)
          }
          if (nodes > allowance.nodes || bytes > allowance.bytes || exprWork > allowance.exprWork) {
            const error = new KernelError('BUDGET', 'Read budget exceeded')
            if (cost !== undefined) cost.refuse(error)
            throw error
          }
          return node ?? null
        } finally { lease.release() }
      },
      async nodeById(id) {
        check()
        const address = targets.address(id)
        if (address !== undefined && resolveStore(address.path) === address.store) {
          const node = await readSource.node(address.path)
          return node === null || node.$id !== id ? null : node
        }
        if (id.startsWith('p:')) {
          const path = id.slice(2)
          if (bindingAt(path) === undefined) return null
          const node = await readSource.node(path)
          return node?.$id === id ? node : null
        }
        for (const [target, binding] of storeBindings) {
          if (!binding.source.identity.owns(id)) continue
          const physical = targets.address(binding.source.identity.source(id))
          const path = binding.source.address(id, physical?.path)
          if (path === undefined || bindingAt(path)?.target !== target) return null
          const node = await readSource.node(path)
          return node?.$id === id ? node : null
        }
        return null
      },
      shard(path) { check(); return shardAt(path) },
    }
    return readSource
  }
  const source: AuthSource = {
    node: path => source.read(read => read.node(path)),
    nodeById: id => source.read(read => read.nodeById(id)),
    shard(path) { available(); return shardAt(path) },
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
    const manifest = module.id === 'kernel' ? withTypeDescriptions(createNativeMountManifest(config.writerEpoch, config.mounts, () => limits, config.federation, { instance: config.id, directories: config.mountDirectories ?? {}, rawfsCodecs: config.rawfsCodecs }), registry) : module
    // An older instance keeps optional builtins uninstalled until its admin installs their ownership.
    const installed = manifest.types.filter(type => owners.has(type.name))
    const names = new Set(installed.flatMap(type => [type.name, ...type.aliases ?? []]))
    registry.publish({ ...manifest, types: installed, security: manifest.security.filter(entry => names.has(entry.type)) })
  }

  if (config.rootExternal === 'trusted') await startExternal(config.root)

  const auth = config.initialCredential === undefined ? undefined : createAuthFactory({ instance: config.id, registry, source,
    shardPath: config.shardPath,
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

  if (storedRoot !== undefined && installationRequired && config.installerCredential === undefined) {
    if (auth === undefined || config.installerLogin === undefined)
      throw new KernelError('UNAUTHENTICATED', 'Module installation requires a credential')
    setupCredential = await auth.login({ account: config.installerLogin.path, password: config.installerLogin.password })
  }

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
  /** Opens explicit selector ranges before Writer barriers; projected references prepare their own targets. */
  async function prepareSource(allowance: Budget, selectors: readonly Selector[], signal: AbortSignal): Promise<void> {
    available()
    if (mounts === undefined) return
    const ranges: ScanRange[] = []
    for (const selector of selectors) {
      if ('node' in selector) ranges.push({ node: selector.node })
      else if ('children' in selector) ranges.push({ children: selector.children })
      else ranges.push({ subtree: selector.history })
      if ('include' in selector) for (const include of selector.include ?? [])
        if ('path' in include) ranges.push({ node: include.path })
    }
    await mounts.prepareRanges(ranges, allowance, signal)
    const bindingSources: ScanRange[] = []
    for (const range of ranges) {
      const path = 'node' in range ? range.node : 'children' in range ? range.children : range.subtree
      const binding = bindingAt(path, !('node' in range))
      if (binding === undefined) continue
      const physical = binding.source.sources(path, binding.source.binding.path)
      for (const source of Object.values(physical)) bindingSources.push('node' in range ? { node: source }
        : 'children' in range ? { children: source } : { subtree: source })
    }
    if (bindingSources.length > 0) await mounts.prepareRanges(bindingSources, allowance, signal)
    const querySources: ScanRange[] = []
    for (const selector of selectors) if ('children' in selector) {
      const found = mounts.resolve(selector.children, true)
      if (found?.target.kind === 'view' && 'selector' in found.target) querySources.push({ children: found.target.selector.children })
    }
    if (querySources.length > 0) {
      await mounts.prepareRanges(querySources, allowance, signal)
      for (const range of querySources) {
        if (!('children' in range)) throw new KernelError('INVALID', 'Query source range must select children')
        if (mounts.resolve(range.children, true)?.target.kind === 'view')
          throw new KernelError('INVALID', 'A query View cannot read another View')
      }
    }
    available()
  }
  /** Composes accepted target metadata and Store reads under one caller budget. */
  /** Pins source routing and read accounting to the selected operation. */
  function readerSource(allowance: Budget, ledger?: ReaderLedger, selectors?: readonly Selector[]): ReaderSource {
    available();
    const rootTarget: ReaderTarget = {
      id: paths.get('/')!,
      store: config.root,
      external: config.rootExternal,
      chain: targets.chain,
      children: targets.children,
    };
    /** Resolves an actual registered target while preserving its semantic generation. */
    function resolve(path: Path): ReaderTarget {
      const found = mounts?.resolve(path);
      if (found === undefined) return rootTarget;
      if (found.target.kind === 'view') throw new KernelError('READ_ONLY', 'A View has no writable Store');
      const binding = bindingAt(path);
      if (binding !== undefined) return bindingTarget(binding);
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
        if (mounts?.resolve(range.node)?.target.kind === 'authority') return [];
        const found = resolve(range.node);
        return [found];
      }
      result.set(config.root, rootTarget);
      for (const claim of mounts?.ranges(range) ?? []) {
        const opened = mounts!.target(claim.key, claim.generation);
        if (opened.kind === 'view' || opened.kind === 'authority') continue;
        const bound = opened.kind === 'store' ? storeBindings.get(opened) : undefined;
        if (bound !== undefined && opened.kind === 'store') { result.set(opened.store, bindingTarget({ ...bound, target: opened })); continue; }
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
    const preparedSelectors: Selector[] = []
    /** Pin selected ranges, encountered includes, and their authorization ancestors. */
    function selectedDomains(): readonly string[] {
      if (selectors === undefined) return addressedDomains()
      const domains = new Set([config.root.domain])
      function addDomain(path: Path): void {
        const target = mounts?.resolve(path)?.target;
        // View output has no Store; its executor retains the domains of its source reads.
        if (target?.kind === 'authority' || target?.kind === 'view') return;
        domains.add(resolve(path).store.domain);
        const binding = bindingAt(path);
        if (binding !== undefined) for (const physical of Object.values(binding.source.sources(path, binding.source.binding.path)))
          domains.add(resolveStore(physical).domain);
      }
      for (const selector of [...selectors, ...preparedSelectors]) {
        const path = 'node' in selector ? selector.node : 'children' in selector ? selector.children : selector.history
        for (const ancestor of [...ancestorPaths(path), path]) addDomain(ancestor)
        const range = 'node' in selector ? { node: selector.node }
          : 'children' in selector ? { children: selector.children } : { subtree: selector.history }
        for (const target of rangeTargets(range)) domains.add(target.store.domain)
        if ('include' in selector) for (const include of selector.include ?? []) {
          if ('ref' in include) continue
          for (const ancestor of [...ancestorPaths(include.path), include.path]) addDomain(ancestor)
        }
      }
      return [...domains]
    }

    return {
      get domains() { return selectedDomains() },
      async prepare(found, signal) {
        await prepareSource(ledger === undefined ? allowance : readerOperationCost(ledger).budget(), found, signal);
        preparedSelectors.push(...found);
      },
      auth: reader(allowance, undefined, ledger),
      resolve,
      targets: rangeTargets,
      topology: (range) => (mounts === undefined ? '[]' : mounts.topology(range)),
    };
  }
  /** Executor ownership remains local, including a configured shard receiver range. */
  function shardAt(path: Path): boolean {
    if (config.shardPath !== undefined && (path === config.shardPath || path.startsWith(`${config.shardPath === '/' ? '' : config.shardPath}/`))) return true
    const target = mounts?.resolve(path)?.target
    return target?.kind === 'authority' && target.authority.kind === 'shard'
  }

  /** Keeps same-zone reads on the accepted shard declaration and actual actor lane. */
  function shardRoute(path: Path, children = false) {
    const found = mounts?.resolve(path, children)
    if (found?.target.kind !== 'authority' || found.target.authority.kind !== 'shard') return undefined
    const owner = shardOwners.get(found.entry.key)
    if (owner === undefined) throw new KernelError('UNAVAILABLE', 'Shard owner is unavailable')
    return { found, owner,
      active() {
        available()
        if (mounts?.resolve(path, children)?.target !== found.target)
          throw new KernelError('CONFLICT', 'Shard target changed')
      } }
  }

  /** Keep all foreign operations on the same accepted mount and local rights fold. */
  function federationAt(path: Path, children = false) {
    const found = mounts?.resolve(path, children)
    if (found?.target.kind !== 'authority') return undefined
    if (found.target.authority.kind !== 'federation') return undefined
    const owner = authorityOwners.get(found.entry.key)
    if (owner === undefined) throw new KernelError('UNAVAILABLE', 'Federation owner is unavailable')
    const declaration = componentEntries(found.entry.node).find(([name]) => name === found.entry.component)
    if (declaration === undefined) throw new KernelError('INVALID', 'Federation declaration is absent')
    const remote = declaration[1].remote
    if (remote !== undefined && typeof remote !== 'string') throw new KernelError('INVALID', 'Malformed federation range')
    const namespace = owner.namespace
    function authorize(request: AuthAdmission, required = R): number {
      request.assertActive()
      available()
      if (mounts?.resolve(path, children)?.target !== found!.target)
        throw new KernelError('CONFLICT', 'Federation target changed')
      const rights = computeRights(request.actor, targets.chain(found!.entry.node.$path), registry)
      if ((rights.bits & R) === 0) throw new KernelError('NOT_FOUND', 'Federation mount is not readable')
      if ((rights.bits & required) !== required) throw new KernelError('FORBIDDEN', 'Federation mount rights are insufficient')
      return rights.bits
    }
    return { found, owner, namespace, authorize }
  }

  /** Binds commands to the current registry, source routing, and operation budget. */
  function commandOptions(admission: AuthAdmission, relay = createShardRelay()): CommandOptions {
    available();
    const options: CommandOptions = {
      withAdmission: narrowed => commandOptions(narrowed, relay),
      writer,
      registry,
      projector,
      registryRevision: () => registryRevision,
      blobs: config.blobs,
      io: config.io,
      admission,
      source(allowance, ledger, selectors) {
        const physical = readerSource(allowance, ledger, selectors);
        const spans = new WeakMap<object, Map<OpenedStoreMountTarget, { query: ReturnType<typeof createReader>; coordinates: Map<Path, Path> }>>()
        function boundReader(binding: NonNullable<ReturnType<typeof bindingAt>>, ownedLedger: ReaderLedger, scope: ReaderBindingScope) {
          let readers = spans.get(scope.span)
          if (readers === undefined) { readers = new Map(); spans.set(scope.span, readers) }
          const existing = readers.get(binding.target)
          if (existing !== undefined) return existing
          const coordinates = new Map<Path, Path>()
          const root = binding.source.binding.path
          const roots = [binding.source.binding.lower, binding.source.binding.upper].sort((left, right) => right.length - left.length)
          const query = createReader({ writer, registry, admission, projector, ledger: ownedLedger, scope,
            budget: allowance, limits, source: readerSource(allowance, ownedLedger),
            scopePath(path) {
              const coordinate = coordinates.get(path)
              if (coordinate !== undefined) return coordinate
              for (const source of roots) if (path === source || path.startsWith(`${source === '/' ? '' : source}/`))
                return `${root === '/' ? '' : root}${path.slice(source === '/' ? 0 : source.length)}` || '/'
              return path
            } })
          const selected = { query, coordinates }
          readers.set(binding.target, selected)
          return selected
        }
        function bindingCurrent(binding: NonNullable<ReturnType<typeof bindingAt>>, path: Path): void {
          admission.assertActive()
          if (bindingAt(path)?.target !== binding.target)
            throw new KernelError('CONFLICT', 'Store binding declaration changed')
        }
        const routed: ReaderSource = { ...physical, get domains() { return physical.domains },
          async mappedNode(path, ownedLedger, scope) {
            const binding = bindingAt(path)
            if (binding === undefined) return undefined
            bindingCurrent(binding, path)
            const opened = binding
            const { query, coordinates } = boundReader(binding, ownedLedger, scope)
            const sources = binding.source.sources(path, binding.source.binding.path)
            const pins: (() => void)[] = []
            const relocated: ReturnType<typeof createReader>[] = []
            function sourceReads() { return combineReadSets([query.expect(), ...relocated.map(reader => reader.expect())]) }
            async function picked(at: Path) {
              const point = at === sources.lower || at === sources.upper
                ? { query, coordinates }
                : boundReader(opened, ownedLedger, { span: {}, check: scope.check, hold: scope.hold })
              point.coordinates.set(at, path)
              if (point.query !== query) relocated.push(point.query)
              let selection: Awaited<ReturnType<typeof point.query.selectInSpan>>
              try { selection = await point.query.selectInSpan({ node: at }) }
              catch (error) {
                if (!(error instanceof KernelError) || error.code !== 'NOT_FOUND') throw error
                scope.check()
                return { node: null, bits: point.query.selectedRights(at) }
              }
              scope.check()
              const image = selection.images[0]
              if (image === undefined) return { node: null, bits: point.query.selectedRights(at) }
              if ('error' in image.copy) throw image.copy.error
              const store = resolveStore(at), raw = writer.cache.getAt(store, at)
              if (raw === undefined || raw.node === null || raw.node.$id !== image.copy.node.$id)
                throw new KernelError('INVALID', 'Selected physical source left its accepted cache image')
              return { node: raw.node, bits: point.query.selectedRights(at), image }
            }
            const upper = await picked(sources.upper)
            let lower = await picked(sources.lower)
            if ((upper.bits & R) === 0 || (lower.bits & R) === 0)
              return { node: null, reads: sourceReads() }
            let selected = binding.source.select({ lower: lower.node, upper: upper.node })
            if (selected?.baseId !== null && selected?.baseId !== undefined && lower.node?.$id !== selected.baseId) {
              const address = targets.address(selected.baseId)
              const root = binding.source.binding.lower
              if (address === undefined || address.path !== root && !address.path.startsWith(`${root === '/' ? '' : root}/`))
                throw new KernelError('NOT_FOUND', 'Store binding lower identity is no longer admitted')
              lower = await picked(address.path)
              if (lower.node?.$id !== selected.baseId || (lower.bits & R) === 0)
                return { node: null, reads: sourceReads() }
              selected = binding.source.select({ lower: lower.node, upper: upper.node })
            }
            bindingCurrent(binding, path)
            const node = binding.source.project(path, { lower: lower.node, upper: upper.node })
            if (node === null) return { node: null, reads: sourceReads() }
            const chain = bindingTarget(binding).chain(path)
            let bits = computeAdmittedRights(admission.actor, chain, registry, admission.shard).bits & upper.bits
            if ((lower.bits & A) === 0) bits &= ~A
            const bytes = Buffer.byteLength(serializeKernel(node))
            readerOperationCost(ownedLedger).charge(0, bytes, Math.ceil(bytes / 8))
            return { node, bits, bytes, reads: sourceReads(),
              retain() {
                scope.check()
                for (const source of [lower, upper]) if (source.image !== undefined) pins.push(source.image.retain())
                const owned = pins.splice(0)
                return () => { for (const release of owned) release() }
              } }
          },
          async mappedChildren(path, ownedLedger, scope) {
            const binding = bindingAt(path, true)
            if (binding === undefined) return undefined
            bindingCurrent(binding, path)
            const { query } = boundReader(binding, ownedLedger, scope)
            const sources = binding.source.sources(path, binding.source.binding.path)
            const paths = new Set<Path>(), sets = []
            for (const source of [sources.lower, sources.upper]) {
              const selection = await query.selectInSpan({ children: source })
              sets.push(selection.reads)
              for (const image of selection.images) {
                if ('error' in image.copy) throw image.copy.error
                const suffix = image.copy.node.$path.slice(source === '/' ? 0 : source.length)
                paths.add(`${path === '/' ? '' : path}${suffix}` || '/')
              }
            }
            bindingCurrent(binding, path)
            return { paths: [...paths], reads: combineReadSets(sets) }
          },
          mapping(preparation, changes, position, executor) {
            if (storeBindings.size === 0) return undefined
            if (ledger === undefined) throw new KernelError('INVALID', 'Store mapping requires the operation ledger')
            return createStoreChangeMapping({ source: routed, ledger, binding: bindingAt,
              check() {
                admission.assertActive()
                readerOperationCost(ledger).budget()
              },
              physical(binding, scope) { return boundReader(binding, ledger, scope).query },
            }, preparation, changes, position, executor)
          },
          async projectedRead(selector, budget, observe, cost) {
            const path = 'node' in selector ? selector.node : 'children' in selector ? selector.children : selector.history;
            await prepareSource(budget, [{ node: path }], admission.signal);
            const target = mounts?.resolve(path, 'children' in selector)?.target;
            if (target?.kind !== 'authority') return undefined;
            observe();
            return options.readAuthority?.(selector, admission, budget, cost);
          } };
        return routed;
      },
      authority: path => mounts?.resolve(path)?.target.kind === 'authority',
      async commitAuthority(input) {
        await prepareSource(input.cost.budget(), changeSelectors(input.request.changes), input.signal)
        const shards: (ReturnType<typeof shardRoute>)[] = []
        for (const change of input.request.changes) {
          switch (change.op) {
            case 'put': shards.push(shardRoute(change.node.$path)); break
            case 'patch': case 'remove': shards.push(shardRoute(change.path)); break
            case 'adopt':
      case 'move': shards.push(shardRoute(change.from), shardRoute(change.to)); break
            case 'restore': case 'undo': {
              const owner = [...shardOwners.values()].find(owner => owner.instance === change.record.pos.instance)
              shards.push(owner === undefined ? undefined : shardRoute(owner.path, true))
              break
            }
          }
        }
        const shard = shards.find(route => route !== undefined)
        if (shard !== undefined) {
          if (shards.some(route => route?.found.target !== shard.found.target))
            throw new KernelError('CROSS_DOMAIN', 'Commit spans different mounted owners')
          const found = shard.found
          return runShardCommit({ input, writer, gates: config.gates ?? [],
            mount: { id: found.entry.node.$id, component: found.entry.component, revision: found.entry.revision },
            open: () => shard.owner.open(admission), active: shard.active,
            own: (client, pending) => relay.track(client, pending, input.requestId ?? pending.id) })
        }
        const routes: (ReturnType<typeof federationAt>)[] = []
        for (const change of input.request.changes) {
          input.cost.charge(0, 0, 1)
          switch (change.op) {
            case 'put': routes.push(federationAt(change.node.$path)); break
            case 'patch': case 'remove': routes.push(federationAt(change.path)); break
            case 'adopt':
      case 'move': routes.push(federationAt(change.from), federationAt(change.to)); break
            case 'restore': case 'undo': {
              const owner = [...authorityOwners.values()].find(owner => owner.namespace.owns(change.record.pos.instance))
              routes.push(owner === undefined ? undefined : federationAt(owner.path, true))
              break
            }
          }
        }
        const route = routes.find(route => route !== undefined)
        if (route === undefined) return undefined
        if (routes.some(current => current?.found.target !== route.found.target))
          throw new KernelError('CROSS_DOMAIN', 'Commit spans different mounted owners')
        const { found, owner, namespace } = route
        return runFederationCommit({ input, writer, namespace, gates: config.gates ?? [],
          mount: { id: found.entry.node.$id, component: found.entry.component, revision: found.entry.revision },
          open: () => owner.open(admission), authorize: () => { route.authorize(input.admission, R | W) } })
      },
      async actAuthority(input) {
        await prepareSource(input.cost.budget(), [{ node: input.request.path }], input.signal)
        const shard = shardRoute(input.request.path)
        if (shard !== undefined) {
          const found = shard.found
          return runShardAction({ input, writer, gates: config.gates ?? [],
            mount: { id: found.entry.node.$id, component: found.entry.component, revision: found.entry.revision },
            open: () => shard.owner.open(admission), active: shard.active,
            own: (client, pending) => relay.track(client, pending, input.requestId ?? pending.id) })
        }
        const route = federationAt(input.request.path)
        if (route === undefined) return undefined
        const { found, owner, namespace } = route
        return runFederationAction({ input, writer, namespace, gates: config.gates ?? [],
          mount: { id: found.entry.node.$id, component: found.entry.component, revision: found.entry.revision },
          open: () => owner.open(admission), authorize: required => { route.authorize(input.admission, required) } })
      },
      async readAuthority(selector, request, allowance, cost) {
        const path = 'node' in selector ? selector.node : 'children' in selector ? selector.children : selector.history
        const shard = shardRoute(path, 'children' in selector)
        if (shard !== undefined) {
          const control = createActionControl(request, allowance.deadline)
          try {
            shard.active()
            const handle = await control.wait(shard.owner.open(admission))
            await control.wait(handle.check())
            shard.active()
            const receipt = await control.wait(handle.connection.readOwned(selector, allowance, control.signal))
            cost?.charge(receipt.cost.nodes, receipt.cost.bytes, receipt.cost.exprWork)
            cost?.request(receipt.cost.requestBytes)
            if ('error' in receipt) throw receipt.error
            const result = receipt.result
            await control.wait(handle.check())
            shard.active()
            if (result.copies.length > allowance.nodes || Buffer.byteLength(serializeKernel(result)) > allowance.bytes)
              throw new KernelError('BUDGET', 'Shard read exceeded the operation budget')
            return result
          } finally { control.close() }
        }
        const route = federationAt(path, 'children' in selector)
        if (route === undefined) return undefined
        const { owner, namespace } = route
        const control = createActionControl(request, allowance.deadline)
        let handle: Awaited<ReturnType<typeof owner.open>> | undefined
        function authorize(): number {
          control.active()
          const required = 'history' in selector ? R | A : R
          return route!.authorize(request, required)
        }
        try {
          authorize()
          const opening = owner.open(admission)
          try { handle = await control.wait(opening) }
          catch (error) { void opening.catch(error => console.error(error)); throw error }
          await control.wait(handle.check())
          authorize()
          const ledger = createReaderLedger(allowance, limits)
          const cost = readerOperationCost(ledger)
          const query = createReader({ registry, writer, admission: request, source: readerSource(allowance, ledger),
            budget: allowance, ledger, limits, projector })
          const delegated = 'children' in selector
            ? { children: selector.children, include: selector.include, queryFields: query.projectedFields(selector) }
            : selector
          const response = await control.wait(handle.client.read(namespace.selector(delegated), control.signal))
          await control.wait(handle.check())
          const mapped = namespace.result(response, authorize(), cost.budget(), (nodes, work) => cost.charge(nodes, 0, work))
          cost.charge(0, Buffer.byteLength(serializeKernel(mapped)))
          const output = 'children' in selector
            ? query.projectedResult(selector, mapped,
                { target: route.found.entry.range.generation, topology: mounts!.topology({ children: selector.children }) })
            : mapped
          if (output.copies.length > allowance.nodes || Buffer.byteLength(serializeKernel(output)) > allowance.bytes)
            throw new KernelError('BUDGET', 'Federation read exceeded the operation budget')
          return output
        } finally { control.close() }
      },

      async readView(selector, request, allowance) {
        let changed: () => void = () => {}
        let pending = new Promise<void>(resolve => { changed = resolve })
        const view = await openView(request, selector, () => changed())
        if (view === undefined) return undefined
        const control = createActionControl(request, allowance.deadline)
        try {
          while (!view.ready) {
            await control.wait(pending)
            pending = new Promise<void>(resolve => { changed = resolve })
          }
          const path = 'node' in selector ? selector.node : selector.children
          const found = mounts?.resolve(path, 'children' in selector)
          if (found?.target.kind !== 'view') throw new KernelError('CONFLICT', 'View target changed')
          await control.wait(createReader({ registry, writer, admission: request, source: readerSource(allowance),
            budget: allowance, limits, projector }).read({ node: found.entry.node.$path }))
          control.active()
          const selection = view.select()
          if (selection === undefined) throw new KernelError('CONFLICT', 'View generation changed')
          const output = { list: selection.roots.flatMap(root => root.member === undefined ? [] : [root.member.id]),
            ownership: selectionOwnership(selection, key => view.cursor(key)),
            copies: selection.images.map(image => image.copy), computed: selection.computed, viewErrors: selection.viewErrors, rows: selection.rows,
            viewOwner: selection.viewOwner,
            next: selection.next, at: selection.at ?? [writer.stream.cursor().pos] }
          if (Buffer.byteLength(serializeKernel(output)) > allowance.bytes)
            throw new KernelError('BUDGET', 'View read result exceeded byte budget')
          return output
        } finally { view.close(); control.close() }
      },
      viewDefinition(selector) {
        const path = 'node' in selector ? selector.node : selector.children
        const found = mounts?.resolve(path, 'children' in selector)
        return found?.target.kind === 'view' ? found.entry.node.$path : undefined
      },
      resolveSelector(selector) {
        if (!('children' in selector)) return selector
        const found = mounts?.resolve(selector.children, true)
        if (found?.target.kind !== 'view' || !('selector' in found.target)) return selector
        const rights = computeRights(admission.actor, targets.chain(found.entry.node.$path), registry)
        if ((rights.bits & 1) === 0) throw new KernelError('NOT_FOUND', 'Query mount is not readable')
        const source = found.target.selector
        const sourceTarget = mounts?.resolve(source.children, true)
        if (sourceTarget?.target.kind === 'view') throw new KernelError('INVALID', 'A View cannot read another View')
        return { ...selector, children: source.children,
          where: selector.where === undefined ? source.where : { $and: [source.where, selector.where] } }
      },
      withNodeExecutor: (target, allowance, signal, wait, run, ledger) =>
        withNodeExecutor(target, allowance, signal, wait, run, ledger, relay),
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
      validate: (prepared) => {
        if (prepared.groups !== undefined) {
          targets.validateGroups(prepared.groups)
          for (const group of prepared.groups)
            validate(new Map(group.writes.map(write => [write.path, write.node])), group.store, false, true)
          return
        }
        validate(
          new Map(prepared.writes.map((write) => [write.path, write.node])),
          prepared.writes.length === 0 ? config.root : resolveStore(prepared.writes[0].path),
        )
      },
    };
    return options;
  }
  /** Holds a genuine node session and pins its own configuration without requiring read grants. */
  async function withNodeExecutor<T>(
    target: NodeActionTarget,
    allowance: Budget,
    signal: AbortSignal,
    wait: <V>(pending: Promise<V>) => Promise<V>,
    run: (binding: NodeActionBinding) => Promise<T>,
    ledger: ReaderLedger | undefined,
    relay: ReturnType<typeof createShardRelay>,
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
        options: commandOptions(opened.admission, relay),
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
  /** Start one declared reporter and reconcile its stopped edits before public admission. */
  async function startExternal(store: Store, root: Path = '/'): Promise<void> {
    if (externalOwners.has(store)) return
    if (store.external === undefined || store.readExternal === undefined)
      throw new KernelError('INVALID', 'Trusted Store requires paired external reporting and reads')
    const control = new AbortController()
    const external = store.external
    /** Preserve actual invariants and accepted indexes before physical images enter the order. */
    async function reconcile(paths: readonly Path[]): Promise<void> {
      await writer.reconcile(store, paths, async (changes, unknown) => {
        control.signal.throwIfAborted()
        const guard = createGuard({ registry, executor: `external:${store.domain}`, readBefore: source.node })
        for (const change of changes) await guard.transition(change.before, change.after)
        const changed = new Map(changes.map(change => [change.after?.$path ?? change.before!.$path, change.after]))
        for (const image of unknown) {
          const address = targets.address(image.id)
          if (address !== undefined && (address.store !== store || address.path !== image.path))
            throw new KernelError('INVALID', 'External current state differs from its accepted identity')
          if (image.after !== null) await guard.transition(null, image.after)
          changed.set(image.path, image.after)
        }
        validate(changed, store, true)
      })
    }
    const reporter = external(control.signal)
    try {
      await reporter.ready
      await reconcile([root])
    } catch (error) {
      control.abort(error)
      throw error
    }
    const done = (async () => {
      try {
        for await (const paths of reporter) {
          if ('t' in paths) {
            await recoverExternal(store, paths.epoch, control.signal)
          } else await reconcile(paths)
        }
      } catch (error) {
        if (error === control.signal.reason) return
        console.error(error)
        if (store.transactionOwner !== undefined) {
          writer.failObservation(store)
          control.abort(error)
          return
        }
        failure = { error }
        sessions?.close()
        throw error
      }
    })()
    void done.catch(() => {})
    externalOwners.set(store, { control, done })
  }

  /** Reconcile bounded current images before reopening the affected observation domain. */
  async function recoverExternal(store: Store, epoch: string, signal: AbortSignal): Promise<void> {
    await writer.recover(store, async (members, accept) => {
      signal.throwIfAborted()
      const recoveryBudget = budget()
      const recovering = []
      for (const member of members) {
        if (journalOnlyStores.has(member)) continue
        cache.retireStore(member)
        recovering.push({ member, prior: targets.invalidate(member) })
      }
      writer.influence.replaceDomains(Object.keys(writer.intake.domains), writer.position, [store.domain])

      for (const { member, prior } of recovering) {
        const census = await member.scan({ range: { census: '/' }, budget: recoveryBudget })
        if (census.next !== undefined) throw new KernelError('BUDGET', 'External recovery census is incomplete')
        const current = new Map(census.items.map(node => [node.$path, node]))
        const paths = [...new Set([...prior.paths.keys(), ...current.keys()])].sort((left, right) => {
          signal.throwIfAborted()
          if (Date.now() >= recoveryBudget.deadline) throw new KernelError('BUDGET', 'External recovery deadline exceeded')
          return comparePaths(left, right)
        })
        for (const path of paths) {
          signal.throwIfAborted()
          const before = prior.paths.get(path), metadata = current.get(path)
          if (before !== undefined && metadata !== undefined && before !== metadata.$id)
            throw new KernelError('INVALID', 'External recovery changes accepted node identity')
          if (metadata !== undefined && prior.chains.get(path)?.types[0] !== undefined
            && prior.chains.get(path)!.types[0] !== metadata.chain.types[0])
            throw new KernelError('INVALID', 'External recovery changes accepted node type')
          await accept(member, [path], async (changes, unknown) => {
            const guard = createGuard({ registry, executor: `external:${member.domain}`, readBefore: reader(budget()).node })
            for (const change of changes) await guard.transition(change.before, change.after)
            const changed = new Map<Path, StoredNode | null>()
            for (const image of unknown) {
              if (image.after !== null) await guard.transition(null, image.after)
              changed.set(image.path, image.after)
            }
            validate(changed, member, true)
          }, async (selected, allowance) => {
            const result = await member.readExternal!(selected, { ...allowance,
              deadline: Math.min(allowance.deadline, recoveryBudget.deadline) })
            if (result.items.length !== 0 || before === undefined) return result
            return { ...result, items: [{ path, id: before, before: 'unknown', after: null }] }
          })
        }
      }
      if (Date.now() >= recoveryBudget.deadline) throw new KernelError('BUDGET', 'External recovery deadline exceeded')
      writer.stream.publish({ t: 'reset', domain: store.domain, epoch })
    })
  }

  /** End the reporter before target retirement waits for its accepted reads and writes. */
  async function stopExternal(store: Store): Promise<void> {
    const owner = externalOwners.get(store)
    if (owner === undefined) return
    owner.control.abort(new KernelError('CANCELLED', 'External Store reporting ended'))
    await owner.done
    externalOwners.delete(store)
  }
  /** Keep each executor read ordered while its asynchronous derive runs outside the Writer barrier. */
  function viewRead(admission: AuthAdmission): ViewRead {
    return async (selector, observeDependency, ledger, check) => {
      check()
      const allowance = readerOperationCost(ledger).budget()
      await prepareSource(allowance, [selector], admission.signal)
      const input = readerSource(allowance, ledger)
      const at = 'node' in selector ? selector.node : 'children' in selector ? selector.children : selector.history
      const resolution = mounts?.resolve(at, 'children' in selector)
      if (resolution?.target.kind === 'view') throw new KernelError('INVALID', 'A View cannot read another View')
      const held: import('#kernel/cache').CacheRead[] = []
      const reads = createReader({ registry, writer, admission, source: input, budget: allowance, ledger,
        limits, projector, observeDependency, scope: { check, hold(lease) { held.push(lease) } } })
      try {
        if ('history' in selector) {
          const result = await reads.read(selector)
          return { roots: [], images: [], fixedIncludes: { covered: [], reads: reads.expect() },
            reads: reads.expect(), at: result.at, history: result.history, next: result.next }
        }
        return await writer.read(input.domains, async () => {
          const selected = await reads.selectInSpan(selector)
          const images = selected.images.map(image => {
            const pin = image.retain()
            let pending = true
            return { ...image, retain() {
              if (pending) { pending = false; return pin }
              const id = 'node' in image.copy ? image.copy.node.$id : image.copy.id
              return writer.cache.retain(id)
            } }
          })
          return { ...selected, images, at: [writer.stream.cursor().pos] }
        })
      } catch (error) { return readerOperationCost(ledger).refuse(error) }
      finally { for (const lease of held) lease.release() }
    }
  }
  /** Build lane options with the caller's admission and instance capabilities. */
  function topologyChanged(listener: (test: (range: ScanRange) => boolean) => void) {
    topologyListeners.add(listener)
    return () => topologyListeners.delete(listener)
  }
  function domainIntersects(domain: string, range: ScanRange): boolean {
    if (domain === config.root.domain) return true
    for (const registered of registeredTargets.values())
      if (registered.store.domain === domain && registered.range.intersects(range)) return true
    return false
  }
  async function openView(admission: AuthAdmission, selector: SubSelector, changed: () => void) {

        const allowance = budget()
        await prepareSource(allowance, [selector], admission.signal)
        const path = 'node' in selector ? selector.node : selector.children
        const found = mounts?.resolve(path, 'children' in selector)
        if (found?.target.kind !== 'view') return undefined
        if ('selector' in found.target) return undefined
        const rights = computeRights(admission.actor, targets.chain(found.entry.node.$path), registry)
        if ((rights.bits & 1) === 0) throw new KernelError('NOT_FOUND', 'View is not readable')
        const viewOwner = { path: found.entry.node.$path, component: found.entry.component }
        /** Bind the result to the exact declaration admitted for this subscription. */
        function owned(subscription: import('#kernel/view').ViewSubscription) {
          return { ...subscription, get version() { return subscription.version }, get ready() { return subscription.ready },
            select(range?: import('#kernel/lane-selection').LaneRange) {
              const current = mounts?.resolve(path, 'children' in selector)
              if (current?.target !== found!.target) return undefined
              const selection = subscription.select(range)
              return selection === undefined ? undefined : { ...selection, viewOwner }
            } }
        }
        if (found.target.executor === 'node') {
          const owner = viewOwners.get(found.entry.key)
          if (owner === undefined) throw new KernelError('UNAVAILABLE', 'View executor is not available')
          return owned(owner.view.subscribe(selector, changed))
        }
        const view = createView({ node: found.entry.node, admission, derive: found.target.derive, executor: 'reader',
          active() {
            const current = mounts?.resolve(path, 'children' in selector)
            if (current?.target !== found.target) throw new KernelError('CONFLICT', 'View target changed')
          },
          read: viewRead(admission), limits: () => limits, budget, observe: writer.stream.observe, topologyChanged, domainIntersects,
          position: () => writer.stream.cursor().pos })
        const subscription = view.subscribe(selector, changed)
        return owned({ key: subscription.key, get version() { return subscription.version }, get ready() { return subscription.ready }, select: subscription.select,
          intersects: subscription.intersects, invalidate: subscription.invalidate, cursor: subscription.cursor,
          close() { subscription.close(); view.close() } })
  }
  function nodeLaneOptions(admission: AuthAdmission): NodeLaneOptions {
    const relay = createShardRelay();
    const options = commandOptions(admission, relay);
    return {
      admission,
      commands: createCommands(options),
      shard: relay,
      async openShard(selector, id, generation) {
        const allowance = budget()
        await prepareSource(allowance, [selector], admission.signal)
        const path = 'node' in selector ? selector.node : selector.children
        const route = shardRoute(path, 'children' in selector)
        if (route === undefined) return undefined
        const control = createActionControl(admission, allowance.deadline)
        try {
          route.active()
          const handle = await control.wait(route.owner.open(admission))
          await control.wait(handle.check())
          route.active()
          return relay.subscribe(handle, id, generation, selector)
        } finally { control.close() }
      },
      async openAuthority(selector, changed) {
        const allowance = budget()
        await prepareSource(allowance, [selector], admission.signal)
        const path = 'node' in selector ? selector.node : selector.children
        const route = federationAt(path, 'children' in selector)
        if (route === undefined) return undefined
        route.authorize(admission)
        const reads = createReader({ registry, writer, admission, source: readerSource(allowance),
          budget: allowance, limits, projector })
        await reads.read({ node: route.found.entry.node.$path })
        const control = createActionControl(admission, allowance.deadline)
        try {
          const handle = await control.wait(route.owner.open(admission))
          await control.wait(handle.check())
          route.authorize(admission)
          return createForeignSubscription({ selector, admission, handle, namespace: route.namespace,
            reads: reads.expect(), authorize: () => route.authorize(admission), changed,
            queryFields: 'children' in selector ? reads.projectedFields(selector) : [],
            project(value, operation) {
              route.authorize(admission)
              if (!('children' in selector)) return value
              const allowance = operation.budget()
              const ledger = createReaderLedger(allowance, limits)
              const query = createReader({ registry, writer, admission, source: readerSource(allowance, ledger),
                budget: allowance, ledger, limits, projector })
              const selected = query.projectedResult(selector, value,
                { target: route.found.entry.range.generation, topology: mounts!.topology({ children: selector.children }) }, {})
              const remaining = readerOperationCost(ledger).budget()
              operation.charge(allowance.nodes - remaining.nodes, allowance.bytes - remaining.bytes,
                allowance.exprWork - remaining.exprWork)
              return selected
            } })
        } finally { control.close() }
      },
      openView: (selector, changed) => openView(admission, selector, changed),
      stream: writer.stream,
      limits: () => limits,
      intake: () => writer.intake.epoch,
      transfers:
        config.blobs === undefined ? undefined : createBlobTransfers(options, config.blobs),
      read: createNodeLaneRead(
        options,
        path => {
          const mounted = mounts?.resolve(path)
          return mounted === undefined ? config.rootExternal !== 'trusted' : mounted.entry.declaration.external !== 'trusted'
        },
      ),
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
      topologyChanged,
      domainIntersects,
    };
  }
  sessions = auth === undefined ? undefined : createSessionFactory({ auth, limits: () => limits, lane: nodeLaneOptions })

  /** Keep the actual declaring lane alive until its owned mount ends or accepted authority is revoked. */
  function mountSession(opened: OpenedSession) {
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
    return { session: opened.session, admission: opened.admission, close: () => opened.session.close() }
  }

  /** Prepared and active targets retain the same accepted credential observation owner. */
  function observeStoreCredential(entry: MountEntry, target: OpenedStoreMountTarget): void {
    const dependency = target.credentialDependency
    if (dependency === undefined) return
    const stop = observeCredential({ path: dependency.path, registry,
      source: () => readerSource(budget()),
      observe(receive) { listeners.add(receive); return () => listeners.delete(receive) },
      topology: topologyChanged }, () => {
        dependency.invalidate()
        mounts!.invalidateCredential(entry.key, entry.range.generation)
      })
    dependency.ownObservation(stop)
  }

  /** Stages root claims before Writer effects; handlers open after the real session factory exists. */
  function buildMountTable(): MountTable {
    return createMountTable({
      registry,
      declarationTypes: mountTypes,
      observeCredential: observeStoreCredential,
      async readDeclaration(node) {
        const allowance = budget()
        return writer.read(() => addressedDomains(), async () => {
          const actual = await reader(allowance).node(node.$path)
          if (actual === null || actual.$id !== node.$id || positionToRev(actual.$pos) !== node.$rev)
            throw new KernelError('CONFLICT', 'Mount declaring node changed before opening')
          return visibleNode(actual, A)
        })
      },
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
        return { session: opened.session, admission: opened.admission, close: () => opened.session.close() }
      },

      reserveSession(node) {
        if (sessions === undefined) throw new KernelError('UNAUTHENTICATED', 'Mount handlers require a node session')
        const reservation = sessions.reserveNode(node.$path, node.$id)
        return { validate: reservation.validate,
          async open(owner) { return mountSession(await reservation.open(owner, { heartbeat: false })) },
          close: reservation.close }
      },
      async bindStore(entry, opened, owner) {
        const root = opened.binding.path
        if (entry.range.start(root) !== root)
          throw new KernelError('INVALID', 'Store binding root differs from its declared mount range')
        for (const path of [opened.binding.lower, opened.binding.upper]) {
          if (path === root || path.startsWith(`${root === '/' ? '' : root}/`))
            throw new KernelError('INVALID', 'Store binding sources recurse into their logical range')
        }
        await prepareSource(budget(), [{ node: opened.binding.lower }, { node: opened.binding.upper }], owner.admission.signal)
        const store = resolveStore(opened.binding.upper)
        const physical = mounts?.resolve(opened.binding.upper)?.target
        const domain = config.domains.find(domain => domain.store === store)
        const resources = physical?.kind === 'store' ? physical.resources : domain === undefined ? undefined
          : { epoch: domain.epoch, persistent: domain.persistent, writerEpoch: config.writerEpoch, decisionHistory: 'retained' as const }
        if (resources === undefined) throw new KernelError('UNAVAILABLE', 'Store binding upper owner is unavailable')
        let target: OpenedStoreMountTarget
        target = ownMountTarget({ kind: 'store', store, resources, async close() {
          storeBindings.get(target)?.stop?.()
          storeBindings.delete(target)
          await opened.close()
        } })
        storeBindings.set(target, { entry, source: createStoreBindingOwner(config.id, entry.node, entry.component, opened.binding) })
        return target
      },

      async activate(entry, target, owner) {
        if (target.kind === 'authority') {
          if (target.authority.kind === 'shard') {
            const accepted = target
            shardOwners.set(entry.key, Object.assign(createShardOwner({ authority: target.authority,
              admission: owner.admission, limits: () => limits,
              observe(listener) {
                const above = (path: Path) => path === '/' || path === entry.node.$path || entry.node.$path.startsWith(`${path}/`)
                const stopStream = writer.stream.observe(event => {
                  if (event.t === 'reset' || event.t === 'commit' && event.record.entries.some(change =>
                    above(change.path) || change.from !== undefined && above(change.from))) listener()
                })
                const receive = (event: AuthEvent) => { if (event.t === 'registry') listener() }
                listeners.add(receive)
                const stopTopology = topologyChanged(intersects => {
                  if (intersects({ node: entry.node.$path })) listener()
                })
                return () => { stopStream(); listeners.delete(receive); stopTopology() }
              },
              async envelope(admission) {
                admission.assertActive()
                if (mounts?.resolve(entry.node.$path, true)?.target !== accepted)
                  throw new KernelError('CONFLICT', 'Shard declaration changed')
                const allowance = budget()
                const query = createReader({ registry, writer, admission, source: readerSource(allowance),
                  budget: allowance, limits, projector })
                const prefix = await query.rightsPrefix(entry.node.$path)
                if (mounts?.resolve(entry.node.$path, true)?.target !== accepted)
                  throw new KernelError('CONFLICT', 'Shard declaration changed')
                return { actor: admission.actor, modules: registry.digest, path: entry.node.$path, prefix }
              } }), { path: entry.node.$path }))
            mounts!.activated(entry.key, entry.revision, target)
            return
          }
          const declaration = componentEntries(entry.node).find(([component]) => component === entry.component)
          if (declaration === undefined || typeof declaration[1].credential !== 'string')
            throw new KernelError('INVALID', 'Federation credential declaration is absent')
          const credential = declaration[1].credential
          const remote = declaration[1].remote
          if (remote !== undefined && typeof remote !== 'string') throw new KernelError('INVALID', 'Malformed federation range')
          authorityOwners.set(entry.key, { path: entry.node.$path,
            namespace: createAuthorityNamespace(config.id, entry.node.$id, entry.component, entry.node.$path, remote ?? '/'),
            ...createFederationOwner({ authority: target.authority, admission: owner.admission,
              limits: () => limits, observe: changed => observeCredential({ path: credential, registry,
                source: () => readerSource(budget()),
                observe(receive) { listeners.add(receive); return () => listeners.delete(receive) },
                topology: topologyChanged }, changed) }) })
          mounts!.activated(entry.key, entry.revision, target)
          return
        }

        if (target.kind === 'view') {
          if (target.executor === 'node') {
            const view = createView({ node: entry.node, admission: owner.admission, derive: target.derive, executor: 'node', sources: target.sources,
              read: viewRead(owner.admission), limits: () => limits, budget, observe: writer.stream.observe, topologyChanged, domainIntersects,
              position: () => writer.stream.cursor().pos })
            viewOwners.set(entry.key, { view, close() { view.close() } })
          }
          mounts!.activated(entry.key, entry.revision, target)
          return
        }
        if (target.kind !== 'store') throw new KernelError('UNAVAILABLE', 'Mount target is not a supported Store')
        if (target.credentialDependency !== undefined) {
          observeStoreCredential(entry, target)
          await target.credentialDependency.check()
        }
        const recovered = await reopenTransferSource(config.root, config.writerEpoch, entry, target, mounts!, registry, budget())
        if (recovered !== undefined) {
          preparedTransferSources.set(target.store, recovered)
          if (recovered.opened !== undefined) writer.retainTarget(recovered.opened)
        }
        const binding = storeBindings.get(target)
        if (binding !== undefined) {
          const rows = await runStoreQuery(budget(), limits.queryMs,
            allowance => target.store.scan({ range: { subtree: binding.source.binding.upper }, budget: allowance }))
          for (const node of rows.items) binding.source.accept(node, node.$path)
          const root = binding.source.binding.upper
          binding.stop = writer.stream.observe(event => {
            if (event.t !== 'commit') return
            const changed = new Set(event.record.entries.flatMap(entry => entry.from === undefined ? [entry.path] : [entry.from, entry.path]))
            const updates = []
            for (const path of changed) {
              if (path !== root && !path.startsWith(`${root === '/' ? '' : root}/`)) continue
              const image = writer.cache.getAt(target.store, path)
              const accepted = targets.target(target.store).paths.get(path)
              if (accepted !== undefined && (image?.node === null || image?.node === undefined || image.node.$id !== accepted))
                throw new KernelError('INVALID', 'Accepted binding metadata left its canonical cache image')
              updates.push({ node: image?.node ?? null, path })
            }
            binding.source.acceptBatch(updates)
          })
          mounts!.activated(entry.key, entry.revision, target)
          return
        }
        // Off-route rows must pass accepted identity checks before entering the shared cache.
        const nodes = preparedTargets.get(target.store) ?? targets.prepare(target.store, (await runStoreQuery(budget(), limits.queryMs,
          allowance => target.store.scan({ range: { census: '/' }, budget: allowance }))).items, recovered?.replacement)
        preparedTargets.set(target.store, nodes)
        preparedEntries.set(target.store, entry)
        try {
          await writer.activateTarget({ key: entry.key, revision: entry.revision, target })
          if (entry.declaration.external === 'trusted') await startExternal(target.store, entry.node.$path)
        } finally {
          preparedTargets.delete(target.store)
          preparedEntries.delete(target.store)
          preparedTransferSources.delete(target.store)
        }
      },

      async retire(entry, target) {
        if (target.kind === 'authority') {
          await shardOwners.get(entry.key)?.close()
          shardOwners.delete(entry.key)
          await authorityOwners.get(entry.key)?.close()
          authorityOwners.delete(entry.key)
          await target.close()
          return
        }

        if (target.kind === 'view') {
          viewOwners.get(entry.key)?.close()
          viewOwners.delete(entry.key)
          await target.close?.()
          return
        }
        if (target.kind === 'store' && storeBindings.has(target)) {
          storeBindings.get(target)!.stop?.()
          storeBindings.delete(target)
          await target.close()
          return
        }
        if (target.kind === 'store') {
          target.credentialDependency?.ownObservation(() => {})
          await stopExternal(target.store)
        }
        await writer.retireTarget(entry.key, entry.revision)
      },
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

  /** Bind service configuration to its real admission and accepted target owner. */
  interface ServiceNodePin {
    readonly node: Node
    readonly invalidated: () => void
  }
  const servicePins = new Map<NodeId, Set<ServiceNodePin>>()

  /** Accepted changes revoke only the registrations pinned to their actual node identity. */
  function invalidateServiceNodes(event: AuthEvent): void {
    if (event.t === 'faults') {
      for (const pins of servicePins.values()) for (const pin of [...pins])
        if (event.changes.some(change => change.path === pin.node.$path || pin.node.$path.startsWith(`${change.path === '/' ? '' : change.path}/`))) pin.invalidated()
      return
    }
    if (event.t === 'registry') {
      for (const pins of servicePins.values()) for (const pin of [...pins]) pin.invalidated()
      return
    }
    for (const change of event.changes) {
      const pins = servicePins.get(change.id)
      if (pins === undefined) continue
      const configuration = change.node === null ? undefined : serviceConfiguration(visibleNode(change.node, 0))
      for (const pin of [...pins])
        if (configuration !== serviceConfiguration(pin.node)) pin.invalidated()
    }
  }

  /** Revoke registrations whose pinned route intersects an accepted mount change. */
  function invalidateServiceRoutes(intersects: (range: ScanRange) => boolean): void {
    for (const pins of servicePins.values()) for (const pin of [...pins])
      if (intersects({ node: pin.node.$path })) pin.invalidated()
  }

  /** Supplies service bootstrap with the real session factory and accepted-identity lookups. */
  function servicePorts(): ServiceBootstrapPorts {
    if (sessions === undefined) throw new KernelError('UNAUTHENTICATED', 'Services require authentication')
    const factory = sessions

    /** Captures a service target while its node admission and current route remain valid. */
    async function captureOwn(opened: Awaited<ReturnType<SessionFactory['openNode']>>, path: Path, expected?: Node): Promise<ServiceTarget> {
      const allowance = budget()
      await prepareSource(allowance, [{ node: path }], opened.admission.signal)
      let input: ReaderSource
      return writer.read(() => {
        input = readerSource(allowance)
        return input.domains
      }, async () => {
        await opened.admission.validate(input.auth)
        const owner = input.resolve(path)
        const stored = await input.auth.node(path)
        if (stored === null || opened.admission.actor.principal !== `n:${stored.$id}`)
          throw new KernelError('CONFLICT', 'Service identity changed')
        const node = freeze(structuredClone(visibleNode(stored, 0)))
        if (expected !== undefined && serviceConfiguration(node) !== serviceConfiguration(expected))
          throw new KernelError('CONFLICT', 'Service configuration changed')
        const handler = registry.security(stored.$type, 'service')
        if (handler === undefined) throw new KernelError('UNAVAILABLE', 'Service handler is unavailable')
        return { node, handler, store: owner.store, generation: owner.id, registryType: registry.type(stored.$type) }
      })
    }

    return {
      openNode: (path, options) => factory.openNode(path, options),
      limits: () => limits,
      captureOwn,

      /** Rechecks the admission, configuration, and route immediately before startup. */
      async validateOwn(opened, target) {
        const current = await captureOwn(opened, target.node.$path, target.node)
        if (current.handler !== target.handler || current.store !== target.store || current.generation !== target.generation
          || current.registryType !== target.registryType) throw new KernelError('CONFLICT', 'Service owner changed')
      },

      /** Resolves the persisted bootstrap marker through the accepted root index. */
      async bootstrapPath() {
        return writer.read(() => addressedDomains(), async () => {
          const path = '/sys/autostart'
          return targets.target(resolveStore(path)).paths.has(path) ? path : undefined
        })
      },

      /** Resolves a kernel-issued node identity through the current address index. */
      async addressById(id) {
        return writer.read(() => addressedDomains(), async () => {
          const address = targets.address(id)
          if (address === undefined) return undefined
          if (resolveStore(address.path) !== address.store)
            throw new KernelError('UNAVAILABLE', 'Reference target route is unavailable')
          return address.path
        })
      },

      /** Observes the accepted identity and removes its invalidation pin on release. */
      observeNode(node, invalidated) {
        const pin = { node, invalidated }
        const pins = servicePins.get(node.$id) ?? new Set<ServiceNodePin>()
        servicePins.set(node.$id, pins)
        pins.add(pin)
        if (servicePins.size === 1 && pins.size === 1) {
          listeners.add(invalidateServiceNodes)
          topologyListeners.add(invalidateServiceRoutes)
        }
        return () => {
          pins.delete(pin)
          if (pins.size === 0) servicePins.delete(node.$id)
          if (servicePins.size === 0) {
            listeners.delete(invalidateServiceNodes)
            topologyListeners.delete(invalidateServiceRoutes)
          }
        }
      },

      /** Notifies discovery when the marker or its owning registry changes. */
      observeBootstrap(changed) {
        let marker = targets.target(resolveStore('/sys/autostart')).paths.get('/sys/autostart')
        const receive = (event: AuthEvent) => {
          if (event.t === 'faults') {
            if (event.changes.some(change => '/sys/autostart' === change.path || '/sys/autostart'.startsWith(`${change.path === '/' ? '' : change.path}/`))) changed()
            return
          }
          if (event.t === 'registry' || event.changes.some(change => change.node?.$path === '/sys/autostart'
            || change.id === marker)) {
            marker = targets.target(resolveStore('/sys/autostart')).paths.get('/sys/autostart')
            changed()
          }
        }
        const topology = (intersects: (range: ScanRange) => boolean) => {
          if (intersects({ node: '/sys/autostart' })) changed()
        }
        listeners.add(receive)
        topologyListeners.add(topology)
        return () => { listeners.delete(receive); topologyListeners.delete(topology) }
      },
    }
  }

  let services: ReturnType<typeof createInstanceServices> | undefined
  let closing: Promise<void> | undefined

  /** Bind an off-route physical copy to the canonical declaration and its fresh Writer intake. */
  function transferSubtree(input: SubtreeTransfer): Promise<Position> {
    available()
    if (mounts === undefined) throw new KernelError('UNAVAILABLE', 'Mount table is not initialized')
    const table = mounts
    return runSubtreeTransfer({ writer, mounts: table, registry, targets, root: config.root, budget, limits: () => limits,
      resolve: resolveStore, retain: replacement => { preparedTransferOwners.add(replacement) },
      handoff: replacement => { preparedTransferOwners.delete(replacement) },
      async activate(prepared) {
        const { replacement, source, stage, allowance } = prepared
        const target = replacement.target
        const scanned = await target.store.scan({ range: { census: '/' }, budget: allowance })
        const nodes = targets.prepare(target.store, scanned.items, source)
        preparedTargets.set(target.store, nodes)
        const route: PreparedTransferRoute = { replacement, source, stage, target,
          revision: replacement.entry.revision, installed: false }
        transferRoutes.set(target.store, route)
        preparedEntries.set(target.store, replacement.entry)
        const registration = { key: replacement.entry.key, revision: replacement.entry.revision, target }

        return writer.activateTarget(registration, { declarationStore: prepared.declarationStore,
          before: prepared.before,
          rejected() {
            replacement.cancelSession()
            const current = transferRoutes.get(target.store)
            if (current?.pos !== undefined) transferPublications.delete(positionToRev(current.pos))
            transferRoutes.delete(target.store)
            preparedTargets.delete(target.store)
            preparedEntries.delete(target.store)
          },
          source: source.store, removed: prepared.removed, check: prepared.check,
          async prepare(pos) {
            prepared.check()
            const after = { ...prepared.draft, $pos: pos }
            await createGuard({ registry, executor: 'kernel', readBefore: async () => prepared.before }).transition(prepared.before, after)
            validate(new Map([[after.$path, after]]), prepared.declarationStore)
            const { $pos, ...fields } = after
            const finalStage = table.stage([table.declarationsOf({ ...fields, $rev: positionToRev($pos) })])
            const entry = replacement.bind(finalStage)
            const bound: BoundTransferRoute = { ...route, stage: finalStage, revision: entry.revision, entry, pos }
            transferRoutes.set(target.store, bound)
            transferPublications.set(positionToRev(pos), bound)
            preparedEntries.set(target.store, entry)

            return { registration: { key: entry.key, revision: entry.revision, target },
              writes: [{ path: after.$path, node: after }], budget: allowance,
              transitions: [{ id: after.$id, before: prepared.before, after }],
              check() { prepared.check(); replacement.validate(finalStage) },
              async accepted(owner) { await replacement.authorize(owner) },
              record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel',
                entries: [{ id: after.$id, path: after.$path,
                  change: { t: 'reconcile', before: prepared.before, after } }] } }
          },
        })
      },
    }, input)
  }

  backfillReady = true
  queueBackfill(config.root)
  for (const target of registeredTargets.values()) queueBackfill(target.store)

  return {
    id: config.id,
    root: config.root,
    registry,
    writer,
    transferSubtree,
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
          async openShard(envelope: ShardEnvelope, signal?: AbortSignal): Promise<ShardConnection> {
            signal?.throwIfAborted()
            const opened = await sessions.openShard(envelope)
            const close = () => opened.session.close()
            signal?.addEventListener('abort', close, { once: true })
            if (signal?.aborted) { close(); signal.throwIfAborted() }
            /** Cancels only the real request while leaving its accepted native outcome intact. */
            function ownPending(pending: ReturnType<typeof opened.session.commit>, requestSignal?: AbortSignal) {
              const cancel = () => opened.session.cancel(pending.id)
              requestSignal?.addEventListener('abort', cancel, { once: true })
              if (requestSignal?.aborted) cancel()
              const release = () => requestSignal?.removeEventListener('abort', cancel)
              void pending.outcome.then(release, release)
              return pending
            }
            return {
              instance: config.id,
              get intake() { opened.admission.assertActive(); return writer.intake.epoch },
              read: opened.session.read,
              readOwned: opened.session.readOwned,
              commit(request, requestSignal) {
                requestSignal?.throwIfAborted()
                return ownPending(opened.session.commit(request), requestSignal)
              },
              act(request, requestSignal) {
                requestSignal?.throwIfAborted()
                return ownPending(opened.session.act(request), requestSignal)
              },
              cancel: opened.session.cancel,
              frames: opened.session.frames,
              poll: opened.session.poll,
              observeReady: opened.session.observeReady,
              update: opened.update,
              send(request) {
                opened.admission.assertActive()
                if (request.t === 'hi') { opened.session.touch(); return }
                opened.session.accept(request)
              },
              async close() { signal?.removeEventListener('abort', close); close() },
            }
          },
        }),
    commands: (admission) => createCommands(commandOptions(admission)),
    readerSource,
    nodeLaneOptions,
    async preparePublications() {
      available()
      for (const path of targets.target(config.root).paths.keys()) {
        if (!path.startsWith(PUBLICATION_PREFIX) && !path.startsWith(ACTION_PUBLICATION_PREFIX)) continue
        const node = await reader(budget()).node(path)
        if (node === null) throw new KernelError('CONFLICT', 'Accepted publication disappeared')
        if (path.startsWith(ACTION_PUBLICATION_PREFIX)) {
          const source = publishedAction(node)
          await verifyActionSource(source.source, source.stream)
          installPublishedAction(registry, source)
        } else installPublishedView(registry, publishedView(node))
      }
      for (const path of targets.target(config.root).paths.keys()) {
        if (!path.startsWith('/sys/types/')) continue
        const node = await reader(budget()).node(path)
        const locators = node?.actionPublications
        if (locators === undefined) continue
        if (typeof locators !== 'object' || locators === null || Array.isArray(locators) || typeof node?.name !== 'string')
          throw new KernelError('INVALID', 'Malformed accepted action locators')
        for (const [action, locator] of Object.entries(locators)) {
          if (locator !== actionPublicationPath(node.name, action)) throw new KernelError('INVALID', 'Action publication locator differs')
          const snapshot = await reader(budget()).node(locator)
          if (snapshot === null) throw new KernelError('CONFLICT', 'Accepted action publication disappeared')
          const source = publishedAction(snapshot)
          if (source.type !== node.name || source.action !== action || source.module !== node.module)
            throw new KernelError('CONFLICT', 'Accepted action source ownership differs')
        }
      }
      available()
    },
    bindAutostartModule(module) {
      if (module.id !== '@treenx/core/autostart') return withTypeDescriptions(module, registry)
      return { ...module, security: [...module.security, {
        type: 't.autostart', context: 'service', handler: createAutostartHandler(servicePorts()),
      }] }
    },
    async prepareServices() {
      available()
      if (services === undefined) services = createInstanceServices(servicePorts())
      await services.ready()
      available()
    },
    /** Opens current accepted mounts before startup exposes mutation intake to callers. */
    async prepareMounts() {
      available()
      await mounts!.prepareRanges([{ subtree: '/' }], budget())
    },
    /** Close the sessions and authentication factory owned by this foundation. */
    close() {
      if (closing !== undefined) return closing
      closed = true
      for (const owner of viewOwners.values()) owner.close()
      viewOwners.clear()
      sessions?.close()
      auth?.close()
      closing = (async () => {
        const errors: unknown[] = []
        const shardClosures = await Promise.allSettled([...shardOwners.values()].map(owner => owner.close()))
        shardOwners.clear()
        for (const result of shardClosures) if (result.status === 'rejected') { console.error(result.reason); errors.push(result.reason) }
        const authorities = await Promise.allSettled([...authorityOwners.values()].map(owner => owner.close()))
        authorityOwners.clear()
        for (const result of authorities) if (result.status === 'rejected') { console.error(result.reason); errors.push(result.reason) }

        const stopped = await Promise.allSettled([...externalOwners.keys()].map(stopExternal))
        for (const result of stopped) if (result.status === 'rejected') errors.push(result.reason)
        try { await services?.close() } catch (error) { console.error(error); errors.push(error) }
        try { await mounts!.close() } catch (error) { console.error(error); errors.push(error) }
        try { await writer.closeTargets() } catch (error) { console.error(error); errors.push(error) }
        for (const owner of preparedTransferOwners) {
          try { await owner.close() } catch (error) { console.error(error); errors.push(error) }
        }
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
