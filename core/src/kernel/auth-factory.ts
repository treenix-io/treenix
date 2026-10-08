import { KernelError } from '#errors'
import { prepareCredential, type PreparedCredential } from '#kernel/auth/credentials'
import { credentialScope, tokenHash } from '#kernel/auth/crypto'
import { authenticateLogin, type LoginInput, type LoginProof } from '#kernel/auth/login'
import { actorDependencyVersion, createActorResolver, type ActorDependency, type ActorResolution,
  type AuthReadSource, type AuthSource } from '#kernel/session'
import type { Actor, Credential, InstanceId, NodeId, Path, Registry, StoredNode } from '#kernel/types'
import { stableJson } from '#util/stable-json'

export interface AuthChange { readonly id: NodeId; readonly node: StoredNode | null }
export type AuthEvent = { readonly t: 'nodes'; readonly changes: readonly AuthChange[] } | { readonly t: 'registry' }
export interface AuthEvents { subscribe(listener: (event: AuthEvent) => void): () => void }
export interface AuthIssuer { issue(proof: LoginProof, credential: PreparedCredential): Promise<void> }
export interface ActorReadInput {
  readonly actor: Actor
  readonly sources: readonly { readonly id: NodeId; readonly version: string }[]
}
export interface AuthAdmission {
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
    if (event.t === 'registry') {
      if (digest === registry.digest) return
      digest = registry.digest
      for (const admission of active) if (admission.resolution.sources.some(dep => dep.kind === 'executor')) admission.close(unauthorized())
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

  function admit(resolution: ActorResolution, origin?: string): AuthAdmission {
    available()
    const controller = new AbortController()
    const input: ActorReadInput = Object.freeze({ actor: resolution.actor,
      sources: Object.freeze(resolution.sources.map(({ id, version }) => Object.freeze({ id, version }))) })
    let timer: ReturnType<typeof setTimeout> | undefined
    function expire(): void {
      const expiresAt = resolution.expiresAt
      if (expiresAt === undefined || controller.signal.aborted) return
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) admission.close(unauthorized())
      else { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); timer.unref() }
    }
    const admission: AuthAdmission = Object.freeze({ actor: resolution.actor, resolution, origin,
      signal: controller.signal, dependencyKey: `actor:${tokenHash(stableJson([resolution.actor.principal, input.sources.map(dep => dep.id)]))}`,
      dependency: () => input,
      assertActive() {
        if (!controller.signal.aborted && resolution.expiresAt !== undefined && Date.now() >= resolution.expiresAt) admission.close(unauthorized())
        controller.signal.throwIfAborted()
      },
      async validate(read: AuthReadSource) {
        admission.assertActive()
        for (const dep of resolution.sources) {
          let node: StoredNode | null
          try { node = await read.nodeById(dep.id) }
          catch (error) {
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
    close() {
      if (closed) return
      closed = true
      unsubscribe()
      for (const admission of active) admission.close()
    },
  }
}

export type AuthFactory = ReturnType<typeof createAuthFactory>
