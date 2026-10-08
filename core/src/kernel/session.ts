import { randomBytes } from 'node:crypto'
import { KernelError } from '#errors'
import { AUTH_KEY_PATH, assertGroups } from '#kernel/auth-module'
import { credentialPath, credentialScope, signAnonymous, tokenHash, verifyAnonymous } from '#kernel/auth/crypto'
import { executorDeclaration } from '#kernel/capability'
import { componentEntries } from '#kernel/migrate'
import { positionToRev } from '#kernel/position'
import type { Actor, Credential, InstanceId, NodeId, Path, Principal, Registry, Rev, StoredNode } from '#kernel/types'
import { stableJson } from '#util/stable-json'

export interface AuthReadSource {
  readonly node: (path: Path) => Promise<StoredNode | null>
  readonly nodeById: (id: NodeId) => Promise<StoredNode | null>
  readonly shard: (path: Path) => boolean
}
export interface AuthSource extends AuthReadSource {
  read<T>(operation: (source: AuthReadSource) => Promise<T>): Promise<T>
}
export interface ActorDependency {
  readonly id: NodeId
  readonly path: Path
  readonly rev: Rev
  readonly version: string
}
export interface ActorResolution {
  readonly actor: Actor
  readonly credential?: Credential
  readonly sources: readonly ActorDependency[]
}

const ANONYMOUS_TTL = 365 * 24 * 60 * 60 * 1000
const unauthenticated = () => new KernelError('UNAUTHENTICATED', 'Invalid credential')

function dependency(node: StoredNode, state: unknown): ActorDependency {
  return Object.freeze({ id: node.$id, path: node.$path, rev: positionToRev(node.$pos), version: tokenHash(stableJson([node.$id, state])) })
}
function resolved(principal: Principal, claims: readonly string[], sources: readonly ActorDependency[], credential?: Credential,
  scope?: readonly Path[]): ActorResolution {
  const actor: Actor = Object.freeze({ principal, claims: Object.freeze([...new Set([principal, ...claims])]),
    ...(scope === undefined ? {} : { scope }) })
  return Object.freeze({ actor, sources: Object.freeze(sources), ...(credential === undefined ? {} : { credential: Object.freeze(credential) }) })
}

export function createActorResolver(options: { readonly instance: InstanceId; readonly registry: Registry; readonly source: AuthSource }) {
  const { instance, registry, source } = options

  function groups(node: StoredNode): readonly string[] {
    const result: string[] = []
    for (const [, component] of componentEntries(node)) {
      if (registry.type(component.$type).name !== 't.groups') continue
      // Dynamic fields cross the Store boundary; reject malformed accepted external edits in full.
      if (!Array.isArray(component.list)) throw new KernelError('INVALID', 'Malformed stored groups')
      for (const group of component.list) {
        if (typeof group !== 'string') throw new KernelError('INVALID', 'Malformed stored group')
        result.push(group)
      }
    }
    assertGroups(result)
    return Object.freeze([...new Set(result)].sort())
  }

  async function resolveCredential(read: AuthReadSource, credential?: Credential): Promise<ActorResolution> {
    if (credential === undefined || credential.token.startsWith('anon.')) {
      const key = await read.node(AUTH_KEY_PATH)
      if (key === null || registry.type(key.$type).name !== 't.auth-key' || key.instance !== instance
        || typeof key.key !== 'string' || !/^[0-9a-f]{64}$/.test(key.key)) throw new KernelError('INVALID', 'Invalid instance auth key')
      const now = Date.now()
      const identity = credential === undefined
        ? { instance, id: randomBytes(16).toString('hex'), issuedAt: now, expiresAt: now + ANONYMOUS_TTL }
        : verifyAnonymous(credential.token, key.key, instance, now)
      const issued = credential ?? { token: signAnonymous(identity, key.key) }
      return resolved(`anon:${identity.id}`, ['public'], [dependency(key, [instance, tokenHash(key.key)])], issued,
        'scope' in identity ? identity.scope : undefined)
    }
    if (!/^[0-9a-f]{64}$/.test(credential.token)) throw unauthenticated()
    const record = await read.node(credentialPath(credential.token))
    if (record === null || registry.type(record.$type).name !== 't.session' || record.revoked !== false
      || typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()
      || typeof record.accountId !== 'string' || record.accountId.startsWith('p:')) throw unauthenticated()
    const account = await read.nodeById(record.accountId)
    if (account === null || registry.type(account.$type).name !== 't.user' || account.status !== 'active') throw unauthenticated()
    if (account.$id !== record.accountId) throw new KernelError('INVALID', 'Account index returned another identity')
    const membership = groups(account), scope = credentialScope(record.scope)
    return resolved(`u:${account.$id}`, ['public', 'authenticated', ...membership], [
      dependency(account, [account.status, membership]),
      dependency(record, [record.accountId, record.revoked, record.expiresAt, scope]),
    ], credential, scope)
  }

  async function resolveNode(read: AuthReadSource, path: Path): Promise<ActorResolution> {
    const node = await read.node(path)
    if (node === null) throw new KernelError('NOT_FOUND', 'Executor node is absent')
    if (node.$id.startsWith('p:') || read.shard(node.$path)) throw new KernelError('INVALID', 'Executor must have a local kernel identity')
    const declaration = executorDeclaration(node, registry)
    if (!declaration.executable) throw new KernelError('INVALID', 'Node has no executor declaration')
    const membership = groups(node)
    if (membership.length !== 0 && !declaration.privileged) throw new KernelError('INVALID', 'Node groups require a privileged capability')
    return resolved(`n:${node.$id}`, membership, [dependency(node, [registry.digest, declaration, membership])])
  }

  return {
    resolveCredential: (credential?: Credential) => {
      const owned = credential === undefined ? undefined : Object.freeze({ token: credential.token })
      return source.read(read => resolveCredential(read, owned))
    },
    resolveNode: (path: Path) => source.read(read => resolveNode(read, path)),
  }
}
