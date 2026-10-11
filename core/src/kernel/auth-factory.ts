import { KernelError } from '#errors'
import { prepareCredential, type PreparedCredential } from '#kernel/auth/credentials'
import { credentialScope, tokenHash } from '#kernel/auth/crypto'
import { authenticateLogin, type LoginInput, type LoginProof } from '#kernel/auth/login'
import { actorDependencyVersion, createActorResolver, type ActorDependency, type ActorResolution,
  type AuthReadSource, type AuthSource } from '#kernel/session'
import type { Actor, Credential, InstanceId, NodeId, Path, Registry, RightsPrefix, ShardEnvelope, StoredNode, StorageFaultChange } from '#kernel/types'
import { stableJson } from '#util/stable-json'
import { readAcceptedNode, type AcceptedNodeRead } from '#kernel/writer'

export interface AuthChange { readonly id: NodeId; readonly node: StoredNode | null }
export type AuthEvent = { readonly t: 'nodes'; readonly changes: readonly AuthChange[] } | { readonly t: 'registry' }
  | { readonly t: 'faults'; readonly changes: readonly StorageFaultChange[] }
export interface AuthEvents { subscribe(listener: (event: AuthEvent) => void): () => void }
export interface AuthIssuer { issue(proof: LoginProof, credential: PreparedCredential): Promise<void> }
export interface ShardRights {
  readonly path: Path
  readonly prefix: RightsPrefix
}

export interface ActorReadInput {
  readonly shard?: ShardRights
  readonly actor: Actor
  readonly sources: readonly { readonly id: NodeId; readonly version: string }[]
}
export interface AuthAdmission {
  readonly shard?: ShardRights
  readonly actor: Actor
  readonly resolution: ActorResolution
  readonly origin?: string
  readonly signal: AbortSignal
  readonly dependencyKey: string
  dependency(): ActorReadInput
  assertActive(): void
  validate(read: AuthReadSource): Promise<void>
  close(reason?: KernelError): void
}
export interface AuthFactoryOptions {
  readonly shardPath?: Path
  readonly instance: InstanceId
  readonly registry: Registry
  readonly source: AuthSource
  readonly events: AuthEvents
  readonly issuer: AuthIssuer
  readonly ttlMs: number
}

export function createAuthFactory(options: AuthFactoryOptions) {
  const { instance, registry, source, events, issuer, ttlMs } = options
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new KernelError('INVALID', 'Credential lifetime must be positive and finite')
  const resolver = createActorResolver({ instance, registry, source, anonymousTtlMs: ttlMs })
  const active = new Set<AuthAdmission>(), dependencies = new Map<NodeId, Map<AuthAdmission, ActorDependency>>()
  let closed = false, digest = registry.digest
  const unauthorized = () => new KernelError('UNAUTHENTICATED', 'Session authorization has ended')
  function available(): void { if (closed) throw new KernelError('CANCELLED', 'Auth factory is closed') }
  function changed(admission: AuthAdmission, dep: ActorDependency, node: StoredNode | null, version?: string): void {
    try {
      if (node === null || (version ?? actorDependencyVersion(node, dep.kind, registry, instance)) !== dep.version) admission.close(unauthorized())
    } catch (error) {
      admission.close(error instanceof KernelError ? error : new KernelError('UNAVAILABLE', 'Auth source failed'))
      console.error(error)
      throw error
    }
  }
  const unsubscribe = events.subscribe(event => {
    if (event.t === 'faults') {
      for (const admission of active) if (event.changes.some(change => change.fault !== null &&
        admission.resolution.sources.some(dep => dep.path === change.path || dep.path.startsWith(`${change.path === '/' ? '' : change.path}/`))))
        admission.close(unauthorized())
      return
    }
    if (event.t === 'registry') {
      if (digest === registry.digest) return
      digest = registry.digest
      for (const admission of active) {
        if (admission.shard !== undefined) admission.close(new KernelError('GENERATION', 'Shard module generation changed'))
        else if (admission.resolution.sources.some(dep => dep.kind === 'executor')) admission.close(unauthorized())
      }
    } else for (const change of event.changes) {
      const affected = dependencies.get(change.id)
      if (affected !== undefined) {
        const versions = new Map<ActorDependency['kind'], string>()
        for (const [admission, dep] of affected) {
          let version = versions.get(dep.kind)
          if (change.node !== null && version === undefined) {
            try { version = actorDependencyVersion(change.node, dep.kind, registry, instance) }
            catch (error) {
              for (const [other] of affected) other.close(error instanceof KernelError ? error : new KernelError('UNAVAILABLE', 'Auth source failed'))
              console.error(error)
              throw error
            }
            versions.set(dep.kind, version)
          }
          changed(admission, dep, change.node, version)
        }
      }
    }
  })

  function admit(resolution: ActorResolution, origin?: string, shard?: () => ShardRights): AuthAdmission {
    available()
    const controller = new AbortController()
    const input: ActorReadInput = Object.freeze({ actor: resolution.actor,
      sources: Object.freeze(resolution.sources.map(({ id, version }) => Object.freeze({ id, version }))) })
    const digestAtOpen = registry.digest
    let timer: ReturnType<typeof setTimeout> | undefined
    function expire(): void {
      const expiresAt = resolution.expiresAt
      if (expiresAt === undefined || controller.signal.aborted) return
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) admission.close(unauthorized())
      else { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); timer.unref() }
    }
    const admission: AuthAdmission = Object.freeze({ actor: resolution.actor, resolution, origin,
      get shard() { return shard?.() },
      signal: controller.signal, dependencyKey: `actor:${tokenHash(stableJson([resolution.actor.principal, input.sources.map(dep => dep.id)]))}`,
      dependency: () => shard === undefined ? input : Object.freeze({ ...input, shard: shard() }),
      assertActive() {
        if (!controller.signal.aborted && resolution.expiresAt !== undefined && Date.now() >= resolution.expiresAt) admission.close(unauthorized())
        controller.signal.throwIfAborted()
        if (shard !== undefined && registry.digest !== digestAtOpen)
          throw new KernelError('GENERATION', 'Shard module generation changed')
      },
      async validate(read: AuthReadSource) {
        admission.assertActive()
        for (const dep of resolution.sources) {
          let node: StoredNode | null
          try { node = await read.nodeById(dep.id) }
          catch (error) {
            admission.assertActive()
            admission.close(error instanceof KernelError ? error : new KernelError('UNAVAILABLE', 'Auth source failed'))
            console.error(error)
            throw error
          }
          changed(admission, dep, node)
          admission.assertActive()
        }
      },
      close(reason = new KernelError('CANCELLED', 'Session closed')) {
        if (controller.signal.aborted) return
        if (timer !== undefined) clearTimeout(timer)
        active.delete(admission)
        for (const dep of resolution.sources) {
          const entries = dependencies.get(dep.id)!
          entries.delete(admission)
          if (entries.size === 0) dependencies.delete(dep.id)
        }
        controller.abort(reason)
      },
    })
    active.add(admission)
    for (const dep of resolution.sources) {
      let entries = dependencies.get(dep.id)
      if (entries === undefined) { entries = new Map(); dependencies.set(dep.id, entries) }
      entries.set(admission, dep)
    }
    expire()
    admission.assertActive()
    return admission
  }

  return {
    /** Accept only the configured same-zone range and current owning module set. */
    openShard(envelope: ShardEnvelope) {
      available()
      if (options.shardPath === undefined || envelope.path !== options.shardPath)
        throw new KernelError('INVALID', 'Shard range differs from its deployment binding')
      if (envelope.modules !== registry.digest) throw new KernelError('GENERATION', 'Shard module set differs')
      const actor = Object.freeze({ ...envelope.actor, claims: Object.freeze([...envelope.actor.claims]),
        ...(envelope.actor.scope === undefined ? {} : { scope: Object.freeze([...envelope.actor.scope]) }) })
      let rights: ShardRights = Object.freeze({ path: envelope.path, prefix: Object.freeze({ ...envelope.prefix }) })
      const admission = admit(Object.freeze({ actor, sources: Object.freeze([]) }), undefined, () => rights)
      return { admission, update(prefix: RightsPrefix) {
        admission.assertActive()
        rights = Object.freeze({ path: envelope.path, prefix: Object.freeze({ ...prefix }) })
      } }
    },
    async login(input: LoginInput): Promise<Credential> {
      available()
      const request: LoginInput = Object.freeze({ account: input.account, password: input.password, scope: credentialScope(input.scope) })
      const proof = await authenticateLogin(source, registry, request)
      available()
      const prepared = prepareCredential(proof.accountId, { expiresAt: Date.now() + ttlMs, scope: request.scope })
      await issuer.issue(proof, prepared)
      return prepared.credential
    },
    openCredential(credential?: Credential, origin?: string): Promise<AuthAdmission> {
      available()
      const owned = credential === undefined ? undefined : Object.freeze({ token: credential.token })
      return source.read(async read => admit(await resolver.resolveCredentialIn(read, owned), origin))
    },
    openNode(path: Path): Promise<AuthAdmission> {
      available()
      return source.read(async read => admit(await resolver.resolveNodeIn(read, path)))
    },
    /** The Writer may supply its already-held accepted read authority during a canonical switch. */
    async openNodeIn(owner: AcceptedNodeRead): Promise<AuthAdmission> {
      available()
      return admit(await resolver.resolveNodeIn({
        async node(path) {
          if (path !== owner.path) throw new KernelError('INVALID', 'Accepted owner cannot read another executor')
          return readAcceptedNode(owner)
        },
        async nodeById() { throw new KernelError('INVALID', 'Accepted owner does not expose an identity reader') },
        shard: () => false,
      }, owner.path))
    },
    close() {
      if (closed) return
      closed = true
      unsubscribe()
      for (const admission of active) admission.close()
    },
  }
}

export type AuthFactory = ReturnType<typeof createAuthFactory>
