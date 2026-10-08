import { isDeepStrictEqual } from 'node:util'
import { ancestorPaths, dirname, isChildPath } from '#core/path'
import { KernelError } from '#errors'
import { decodeChainNode } from '#kernel/chain-index'
import type { NodeChange } from '#kernel/changeset'
import { componentEntries } from '#kernel/migrate'
import { positionToRev } from '#kernel/position'
import type { Path, Preconditions, Principal, Registry, StoredNode } from '#kernel/types'

export interface CapabilityState {
  readonly node: (id: string) => Promise<StoredNode | null>
  readonly grants: (principal: Principal) => Iterable<Path>
  readonly ownerGrants: Iterable<Path>
  readonly shard: (path: Path) => boolean
}
export interface CapabilityOptions {
  readonly registry: Registry
  readonly state: CapabilityState
  readonly readBefore: (path: Path) => Promise<StoredNode | null>
  readonly requireA: (path: Path) => Promise<void>
  readonly admin: boolean
  readonly expect?: Preconditions
}

export function executorDeclaration(node: StoredNode, registry: Registry): { readonly executable: boolean; readonly privileged: boolean } {
  let executable = false, privileged = false
  for (const name of decodeChainNode(node).types) {
    const def = registry.type(name)
    const declared = Object.values(def.actions).some(action => action.kind === 'setuid')
      || registry.security(name, 'mount') !== undefined || registry.security(name, 'service') !== undefined
      || registry.security(name, 'derive') !== undefined
    executable ||= declared
    privileged ||= declared && def.security === 'privileged-capability'
  }
  return { executable, privileged }
}

/** An ACL grant can update its own target while preserving the pinned executor configuration. */
function sameExecutorConfiguration({ before, after }: NodeChange): boolean {
  if (before === null || after === null) return false

  for (const field of Object.keys(before)) {
    if (field === '$acl' || field === '$pos') continue
    if (!Object.hasOwn(after, field) || !isDeepStrictEqual(before[field], after[field])) return false
  }
  for (const field of Object.keys(after)) {
    if (field === '$acl' || field === '$pos') continue
    if (!Object.hasOwn(before, field)) return false
  }
  return true
}

export async function guardCapabilities(changes: readonly NodeChange[], options: CapabilityOptions): Promise<void> {
  const { registry, state, readBefore, requireA, admin, expect } = options
  const after = new Map<Path, StoredNode | null>()
  const changed = new Map<string, NodeChange>()
  const ownership = new Set<Path>()
  for (const change of changes) {
    changed.set(change.id, change)
    if (change.before !== null) after.set(change.before.$path, null)
    if (change.before?.$owner !== change.after?.$owner || change.before?.$owner !== undefined
      && change.before.$path !== change.after?.$path) {
      if (change.before !== null) ownership.add(change.before.$path)
      if (change.after !== null) ownership.add(change.after.$path)
    }
  }
  for (const change of changes) if (change.after !== null) after.set(change.after.$path, change.after)
  const readAfter = (path: Path) => after.has(path) ? Promise.resolve(after.get(path)!) : readBefore(path)
  async function owner(path: Path, read: typeof readBefore): Promise<Principal | undefined> {
    let value: Principal | undefined
    for (const ancestor of ancestorPaths(path)) value = (await read(ancestor))?.$owner ?? value
    return value
  }
  async function nodeGrants(node: StoredNode | null, read: typeof readBefore): Promise<Map<Principal, number>> {
    const result = new Map<Principal, number>()
    if (node === null) return result
    const currentOwner = await owner(node.$path, read)
    for (const entry of decodeChainNode(node).acl) {
      if (!('grant' in entry) || entry.grant === 0) continue
      const principal = 'owner' in entry.subject ? currentOwner : entry.subject.group
      if (principal === undefined || !principal.startsWith('n:')) continue
      const subject: Principal = `n:${principal.slice(2)}`
      result.set(subject, (result.get(subject) ?? 0) | entry.grant)
    }
    return result
  }
  async function grantNode(principal: Principal): Promise<void> {
    const id = principal.slice(2)
    if (id.startsWith('p:')) throw new KernelError('INVALID', 'A path identity cannot receive grants')
    const node = await state.node(id)
    if (node === null || state.shard(node.$path)) throw new KernelError('INVALID', 'A grant requires a local executor node')
    if (!executorDeclaration(node, registry).executable) throw new KernelError('INVALID', 'The node cannot be an executor')
    await requireA(node.$path)
    const pin = expect?.nodes?.find(input => input.path === node.$path)
    if (pin === undefined) throw new KernelError('INVALID', 'A node grant requires a named version')
    const change = changed.get(node.$id)
    if (pin.rev !== positionToRev(node.$pos) || change !== undefined && !sameExecutorConfiguration(change)) {
      throw new KernelError('CONFLICT', 'The named executor version changed')
    }
  }
  async function grants(before: StoredNode | null, next: StoredNode | null): Promise<void> {
    const previous = await nodeGrants(before, readBefore), current = await nodeGrants(next, readAfter)
    for (const [principal, bits] of current) if ((bits & ~(previous.get(principal) ?? 0)) !== 0) {
      await requireA(before?.$path ?? dirname(next!.$path) ?? '/')
      await grantNode(principal)
    }
  }

  for (const change of changes) {
    for (const node of [change.before, change.after]) {
      if (node === null) continue
      const types = decodeChainNode(node).types.map(name => registry.type(name))
      if (!admin && (types.some(type => type.security === 'privileged-capability')
        || componentEntries(node).some(([, component]) => registry.type(component.$type).name === 't.groups'))) {
        throw new KernelError('FORBIDDEN', 'Only an administrator may write this capability')
      }
    }
    const node = change.before ?? change.after
    if (!admin && node !== null) {
      for (const path of state.grants(`n:${node.$id}`)) await requireA(path)
    }
    await grants(change.before, change.after)
  }
  // Inherited ownership can rebind an unchanged owner grant anywhere below a changed ancestor.
  for (const path of state.ownerGrants) if (!after.has(path) && [...ownership].some(parent => parent === path || isChildPath(parent, path, false))) {
    const node = await readBefore(path)
    await grants(node, node)
  }
}
