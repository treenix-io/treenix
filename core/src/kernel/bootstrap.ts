import { ancestorPaths, assertSafePath, isChildPath } from '#core/path'
import { kernelManifest } from '#kernel/builtins'
import { KernelError } from '#errors'
import { AUTH_KEY_PATH, authKeyInput, authManifest, prepareAdmin, type AdminInput } from '#kernel/auth-module'
import { prepareChangeSet } from '#kernel/changeset'
import type { ProcessCache } from '#kernel/cache'
import { readLimits } from '#kernel/limits'
import { positionToRev } from '#kernel/position'
import { createRegistry, type TypeOwnership } from '#kernel/registry'
import { DEFAULT_LIMITS, R, W, A, type Budget, type InstanceId, type Limits, type NodeId, type NodeInput,
  type Registry, type Store, type StoredNode } from '#kernel/types'
import type { Writer } from '#kernel/writer'

export const LIMITS_PATH = '/sys/limits'
export const TYPE_PATH = '/sys/types'
export const bootstrapModules = [kernelManifest, authManifest] as const

export interface BootstrapIdentity {
  readonly adminId: NodeId
  readonly adminPath: string
}

export function ownershipRecord(node: StoredNode): TypeOwnership {
  if (node.$type !== 't.type' || typeof node.name !== 'string' || node.$path !== `${TYPE_PATH}/${node.name}`
    || typeof node.module !== 'string' || node.module.length === 0
    || node.security !== 'ordinary' && node.security !== 'user-capability' && node.security !== 'privileged-capability') {
    throw new KernelError('INVALID', 'Malformed persisted type ownership')
  }
  return Object.freeze({ module: node.module, security: node.security })
}

export function storedLimits(node: StoredNode): Limits {
  if (node.$type !== 't.limits' || node.$path !== LIMITS_PATH) throw new KernelError('INVALID', 'Invalid limits node')
  return Object.freeze(readLimits({ ...node, $rev: positionToRev(node.$pos) }))
}

export function bootstrapIdentity(root: StoredNode, instance: InstanceId): BootstrapIdentity {
  if (root.$type !== 't.root' || root.$path !== '/' || root.instance !== instance
    || typeof root.adminId !== 'string' || root.adminId.length === 0 || root.adminId.startsWith('p:')
    || typeof root.adminPath !== 'string') throw new KernelError('INVALID', 'Invalid instance root')
  assertSafePath(root.adminPath)
  return Object.freeze({ adminId: root.adminId, adminPath: root.adminPath })
}

export function assertAuthKey(node: StoredNode | null, instance: InstanceId): void {
  if (node === null || node.$type !== 't.auth-key' || node.$path !== AUTH_KEY_PATH || node.instance !== instance
    || typeof node.key !== 'string' || !/^[0-9a-f]{64}$/.test(node.key)) throw new KernelError('INVALID', 'Invalid instance signing key')
}

export function assertBootstrapState(instance: InstanceId, nodes: Pick<ReadonlyMap<string, StoredNode>, 'get'>): BootstrapIdentity {
  const root = nodes.get('/'), limits = nodes.get(LIMITS_PATH)
  if (root === undefined || limits === undefined) throw new KernelError('INVALID', 'Incomplete instance bootstrap')
  const identity = bootstrapIdentity(root, instance)
  assertAuthKey(nodes.get(AUTH_KEY_PATH) ?? null, instance)
  storedLimits(limits)
  for (const module of bootstrapModules) for (const type of module.types) for (const name of [type.name, ...type.aliases ?? []]) {
    const node = nodes.get(`${TYPE_PATH}/${name}`)
    if (node === undefined) throw new KernelError('INVALID', 'Missing built-in type ownership')
    const owner = ownershipRecord(node)
    if (owner.module !== type.module || owner.security !== type.security) throw new KernelError('FORBIDDEN', 'Built-in type ownership differs')
  }
  return identity
}

export async function bootstrap(options: { readonly instance: InstanceId; readonly store: Store; readonly writer: Writer;
  readonly cache: ProcessCache; readonly admin: AdminInput; readonly budget: () => Budget;
  readonly node: (path: string) => Promise<StoredNode | null> }): Promise<BootstrapIdentity> {
  const adminInput = Object.freeze({ ...options.admin })
  assertSafePath(adminInput.path)
  if (adminInput.path === '/' || ['/sys', '/auth/credentials', '/auth/sessions'].some(path =>
    adminInput.path === path || isChildPath(path, adminInput.path, false))
    || adminInput.path === '/auth' || adminInput.path === '/auth/users') throw new KernelError('INVALID', 'Reserved first-account path')
  const admin = await prepareAdmin(adminInput)
  const registry: Registry = createRegistry()
  for (const module of bootstrapModules) registry.publish(module)
  let identity: BootstrapIdentity | undefined
  await options.writer.commit(options.store, [], async pos => {
    const parents = ancestorPaths(adminInput.path).slice(1, -1)
    const first = await prepareChangeSet({ store: options.store, cache: options.cache, registry, budget: options.budget(),
      readBefore: options.node }, [...parents.map($path => ({ op: 'put' as const, node: { $path, $type: 't.dir' } })),
      { op: 'put', node: admin.account }], pos, { executor: 'kernel', caller: 'kernel' })
    const account = first.writes.find(write => write.path === adminInput.path)?.node
    if (account === undefined || account === null) throw new KernelError('INVALID', 'First account was not prepared')
    const preparedIdentity = Object.freeze({ adminId: account.$id, adminPath: account.$path })
    const staged = new Map(first.writes.map(write => [write.path, write.node]))
    const directories = ['/auth', '/auth/users', '/auth/credentials', '/auth/sessions', '/sys', TYPE_PATH]
    const inputs: NodeInput[] = [
      { $path: '/', $type: 't.root', instance: options.instance, ...preparedIdentity,
        $acl: [{ subject: { group: 'admins' }, grant: R | W | A }] },
      ...directories.filter(path => !staged.has(path)).map($path => ({ $path, $type: 't.dir' })),
      ...bootstrapModules.flatMap(module => module.types.flatMap(type => [type.name, ...type.aliases ?? []].map(name =>
        ({ $path: `${TYPE_PATH}/${name}`, $type: 't.type', name, module: type.module, security: type.security })))),
      { $path: LIMITS_PATH, $type: 't.limits', ...DEFAULT_LIMITS },
      authKeyInput(options.instance), admin.passwordRecord(account.$id),
    ]
    const second = await prepareChangeSet({ store: options.store, cache: options.cache, registry, budget: options.budget(),
      readBefore: async path => staged.has(path) ? staged.get(path)! : options.node(path) },
    inputs.map(node => ({ op: 'put', node })), pos, { executor: 'kernel', caller: 'kernel' })
    if (first.transitions.length + second.transitions.length > DEFAULT_LIMITS.changeSet)
      throw new KernelError('BUDGET', 'Bootstrap ChangeSet transition budget exceeded')
    identity = preparedIdentity
    return { writes: [...first.writes, ...second.writes], transitions: [...first.transitions, ...second.transitions],
      record: { ...second.record, kind: 'kernel', entries: [...first.record.entries, ...second.record.entries] } }
  })
  if (identity === undefined) throw new KernelError('INVALID', 'Bootstrap did not commit')
  return identity
}
