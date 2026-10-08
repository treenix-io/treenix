import { KernelError } from '#errors'
import { AUTH_KEY_PATH, assertAdminInput } from '#kernel/auth-module'
import { createAuthFactory, type AuthEvent, type AuthFactory } from '#kernel/auth-factory'
import { recheckLogin } from '#kernel/auth/login'
import { assertAdminPath, assertAuthKey, assertBootstrapState, bootstrap, bootstrapIdentity, bootstrapModules, LIMITS_PATH,
  ownershipRecord, storedLimits, TYPE_PATH, type BootstrapIdentity } from '#kernel/bootstrap'
import { createProcessCache, type Image } from '#kernel/cache'
import { createBlobTransfers } from '#kernel/blobs'
import { createChainIndex } from '#kernel/chain-index'
import { prepareChangeSet, type ChangeExecutor } from '#kernel/changeset'
import { createCommands, type CommandOptions, type NativeCommands } from '#kernel/commands'
import { judgeGates } from '#kernel/gates'
import type { NodeLaneOptions } from '#kernel/lane'
import type { NodeLane } from '#kernel/lane'
import { createSessionFactory, type SessionFactory } from '#kernel/session-factory'
import { createNodeLaneRead } from '#kernel/lane-source'
import { copyManifest, createRegistry, type TypeOwnership } from '#kernel/registry'
import { assertTypeOwner, installModuleOwnership, previewModules } from '#kernel/module-install'
import { loadAllMods, publishLoadedModules } from '#mod/loader'
import { createProjector } from '#kernel/projection'
import type { AuthReadSource, AuthSource } from '#kernel/session'
import type { AuthAdmission } from '#kernel/auth-factory'
import { DEFAULT_LIMITS, type AdminInput, type Budget, type ChangeMember, type Credential, type InstanceConfig, type InstanceId, type Limits, type ModuleManifest, type NodeId,
  type BlobStore, type Gate, type InstanceStream, type Path, type Position, type PositionCounter, type Registry, type Store, type StoreCommit, type StoredNode, type StreamCursor, type StreamDomain } from '#kernel/types'
import { assertWriterDomains, createWriter, type Writer } from '#kernel/writer'

export interface InstanceFoundationConfig {
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
  close(): void
  limits(): Limits
  commit(changes: readonly ChangeMember[], who: ChangeExecutor): Promise<Position>
  commands(admission: AuthAdmission): NativeCommands
  /** Build lane options bound to the supplied admission. */
  nodeLaneOptions(admission: AuthAdmission): NodeLaneOptions
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
    gates: input.gates === undefined ? undefined : Object.freeze([...input.gates]),
    counter: provisioning.counter,
    writerEpoch: provisioning.writerEpoch,
    domains: Object.freeze(provisioning.domains.map(domain => Object.freeze({ ...domain }))),
    credentialTtlMs: provisioning.credentialTtlMs,
    bootstrapPolicy,
    modules: input.modules?.map(copyManifest), allowPartialMods: input.allowPartialMods,
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
    blobs: config.blobs,
    gates: config.gates,
    modules,
    initialCredential: { ttlMs: config.credentialTtlMs },
    installerCredential: bootstrapPolicy.kind === 'reopen' ? bootstrapPolicy.installerCredential : undefined,
    ...(bootstrapPolicy.kind === 'fresh' ? { firstAdmin: bootstrapPolicy.admin } : {}),
  })
  try {
    await installModuleOwnership(
      instance,
      modules,
      bootstrapPolicy.kind === 'reopen' ? bootstrapPolicy.installerCredential : undefined,
    )
    if (discovered === undefined) for (const module of modules) instance.registry.publish(module)
    else await publishLoadedModules(instance.registry, discovered, { allowPartialMods: config.allowPartialMods })
    return instance
  } catch (error) {
    instance.close()
    throw error
  }
}

export function createInstanceFoundation(input: AuthInstanceFoundationConfig): Promise<InstanceFoundationWithAuth>
export function createInstanceFoundation(input: InstanceFoundationConfig): Promise<InstanceFoundation>
export async function createInstanceFoundation(input: InstanceFoundationConfig): Promise<InstanceFoundation> {
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

  const paths = new Map<string, NodeId>(), ids = new Map<NodeId, string>()
  const owners = new Map<string, TypeOwnership>(), chains = createChainIndex()
  let identity: BootstrapIdentity | undefined
  let setupCredential: Credential | undefined
  let accepted = false, failure: { readonly error: unknown } | undefined
  let registryRevision = 0
  const listeners = new Set<(event: AuthEvent) => void>()
  function notify(event: AuthEvent): void { for (const listener of listeners) listener(event) }
  const registry = createRegistry({ ownership: name => owners.get(name), published() { registryRevision++; notify({ t: 'registry' }) } })
  const projector = createProjector({ registry, alert: (path, error) => console.error(path, error) })

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
    writer = await createWriter({ instance: config.id, root: config.root, writerEpoch: config.writerEpoch,
      domains: config.domains, counter: config.counter, budget, applied: publish, cache })
  } finally { initial.release() }

  function reader(allowance: Budget, active = () => true): AuthReadSource {
    let nodes = 0, bytes = 0
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
        if (nodes >= allowance.nodes) throw new KernelError('BUDGET', 'Read node budget exceeded')
        const lease = await writer.cache.fill(config.root, { node: path }, { ...allowance,
          nodes: allowance.nodes - nodes, bytes: allowance.bytes - bytes })
        try {
          check()
          const node = lease.nodes[0]
          if (node === undefined || node.$id !== id) throw new KernelError('INVALID', 'Accepted identity differs from the root Store')
          nodes++; bytes += Buffer.byteLength(JSON.stringify(node))
          if (nodes > allowance.nodes || bytes > allowance.bytes) throw new KernelError('BUDGET', 'Read budget exceeded')
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
  for (const module of bootstrapModules) registry.publish(module)

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
          grants: principal => chains.grantsTo(principal), ownerGrants: chains.grants({ owner: true }), shard: readSource.shard } },
      changes, pos, who)
      validate(new Map(prepared.writes.map(write => [write.path, write.node])))
      return prepared
    })
  }
  function commandOptions(admission: AuthAdmission): CommandOptions {
    available()
    const target = { id: paths.get('/')!, store: config.root, chain: chains.chain, children: chains.children }
    return { writer, registry, projector, registryRevision: () => registryRevision,
        blobs: config.blobs,
        admission, source: allowance => ({ domains: [config.root.domain], auth: reader(allowance), resolve: () => target }),
        capabilities: allowance => {
          const readSource = reader(allowance)
          return { node: readSource.nodeById, grants: principal => chains.grantsTo(principal),
            ownerGrants: chains.grants({ owner: true }), shard: source.shard }
        },
        gates: config.gates ?? [], limits: () => limits,
        budget: kind => config.budget === undefined && kind === 'action' ? { ...budget(), deadline: Date.now() + limits.actionMs } : budget(),
        validate: prepared => validate(new Map(prepared.writes.map(write => [write.path, write.node]))) }
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
    };
  }
  const sessions = auth === undefined ? undefined : createSessionFactory({ auth, limits: () => limits, lane: nodeLaneOptions })
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
    nodeLaneOptions,
    /** Close the sessions and authentication factory owned by this foundation. */
    close() {
      sessions?.close();
      auth?.close();
    },
    limits() {
      available();
      return limits;
    },
    commit,
  }
}
