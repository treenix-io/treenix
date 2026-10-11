import { ancestorPaths } from '#core/path'
import { KernelError } from '#errors'
import { createChainIndex, decodeChainNode } from '#kernel/chain-index'
import type { ChainNode } from '#kernel/rights'
import type { NodeId, Path, Principal, Store, StoreCensusNode, StoredNode } from '#kernel/types'
import type { StoreCommitGroup } from '#kernel/types'
import { sameStoreOwner } from '#kernel/store/owner'

export interface AcceptedTargetIndex {
  readonly store: Store
  readonly paths: Map<Path, NodeId>
  readonly chains: ReturnType<typeof createChainIndex>
}

export interface AcceptedAddress {
  readonly store: Store
  readonly path: Path
}
export interface AcceptedTargetReplacement {
  readonly store: Store
  readonly paths: ReadonlySet<Path>
}

/** Indexes accepted identities and rights without retaining node bodies outside the process cache. */
export function createAcceptedTargets(root: Store, resolve: (path: Path) => Store,
  current?: (store: Store, path: Path, accepted: NodeId | undefined) => StoredNode | null | undefined) {
  const targets = new Map<Store, AcceptedTargetIndex>()
  const ids = new Map<NodeId, AcceptedAddress>()
  const rootIndex = empty(root)
  targets.set(root, rootIndex)

  /** Builds an off-route metadata owner for one actual Store. */
  function empty(store: Store): AcceptedTargetIndex {
    return { store, paths: new Map(), chains: createChainIndex() }
  }

  /** Refuses identity reuse before any accepted metadata changes. */
  function validate(store: Store, changed: ReadonlyMap<Path, StoredNode | null>): void {
    const staged = new Set<NodeId>()
    for (const node of changed.values()) {
      if (node === null) continue
      if (staged.has(node.$id)) throw new KernelError('INVALID', 'Duplicate accepted node identity')
      staged.add(node.$id)
      const prior = ids.get(node.$id)
      if (prior !== undefined && (prior.store !== store || prior.path !== node.$path && !changed.has(prior.path)))
        throw new KernelError('INVALID', 'Duplicate accepted node identity')
    }
  }

  /** Checks all final identities and removed source addresses before a cross-handle publication. */
  function validateGroups(groups: readonly StoreCommitGroup[]): void {
    const removed = new Map<Store, Set<Path>>(), staged = new Set<NodeId>()
    for (const group of groups) {
      target(group.store)
      removed.set(group.store, new Set(group.writes.map(write => write.path)))
    }
    for (const group of groups) for (const write of group.writes) {
      const node = write.node
      if (node === null) continue
      if (staged.has(node.$id)) throw new KernelError('INVALID', 'Duplicate accepted node identity')
      staged.add(node.$id)
      const prior = ids.get(node.$id)
      if (prior !== undefined && (prior.store !== group.store || prior.path !== node.$path) &&
        (!sameStoreOwner(prior.store, group.store) || removed.get(prior.store)?.has(prior.path) !== true))
        throw new KernelError('INVALID', 'Duplicate accepted node identity')
    }
  }

  /** Refuses metadata collisions before acquiring Writer publication authority. */
  function validateAttach(index: AcceptedTargetIndex, replacement?: AcceptedTargetReplacement): void {
    const store = index.store
    if (targets.has(store)) throw new KernelError('INVALID', 'Store metadata is already registered')
    const staged = new Set<NodeId>()
    for (const [path, id] of index.paths) {
      if (staged.has(id)) throw new KernelError('INVALID', 'Duplicate accepted node identity')
      staged.add(id)
      const prior = ids.get(id)
      if (prior !== undefined && (prior.store !== store || prior.path !== path)
        && (replacement === undefined || prior.store !== replacement.store || prior.path !== path || !replacement.paths.has(path)))
        throw new KernelError('INVALID', 'Duplicate accepted node identity')
    }
  }

  /** Stages canonical metadata without retaining the census rows or ordinary bodies. */
  function prepare(store: Store, nodes: readonly StoreCensusNode[], replacement?: AcceptedTargetReplacement): AcceptedTargetIndex {
    const index = empty(store)
    for (const node of nodes) {
      if (index.paths.has(node.$path)) throw new KernelError('INVALID', 'Duplicate accepted Store path')
      if (node.chain.path !== node.$path || node.chain.id !== node.$id)
        throw new KernelError('INVALID', 'Census identity differs from canonical rights metadata')
      index.paths.set(node.$path, node.$id)
      index.chains.putChain(node.chain)
    }
    validateAttach(index, replacement)
    return index
  }

  /** Installs the prepared Store index before its routing becomes visible. */
  function attach(index: AcceptedTargetIndex, replacement?: AcceptedTargetReplacement): AcceptedTargetIndex {
    validateAttach(index, replacement)
    if (replacement !== undefined) for (const path of replacement.paths) remove(replacement.store, path)
    const store = index.store
    targets.set(store, index)
    for (const [path, id] of index.paths) ids.set(id, { store, path })
    return index
  }

  /** Removes only the retired Store's metadata, preserving every other target's identity. */
  function detach(store: Store): void {
    if (store === root) throw new KernelError('INVALID', 'Root metadata is borrowed')
    const index = target(store)
    for (const [path, id] of index.paths) {
      const address = ids.get(id)
      if (address?.store === store && address.path === path) ids.delete(id)
    }
    targets.delete(store)
  }

  /** Resolves the exact metadata owner; absent registration is an unavailable target. */
  function target(store: Store): AcceptedTargetIndex {
    const index = targets.get(store)
    if (index === undefined) throw new KernelError('UNAVAILABLE', 'Store metadata is unavailable')
    return index
  }

  /** Publishes one accepted node into its Store's identity and rights indexes. */
  function put(store: Store, node: StoredNode): void {
    const index = target(store)
    const prior = ids.get(node.$id)
    if (prior !== undefined && (prior.store !== store || prior.path !== node.$path))
      throw new KernelError('INVALID', 'Duplicate accepted node identity')
    index.paths.set(node.$path, node.$id)
    index.chains.put(node)
    ids.set(node.$id, { store, path: node.$path })
  }

  /** Removes an accepted address before installing the replacement images of the same commit. */
  function remove(store: Store, path: Path): void {
    const index = target(store)
    const id = index.paths.get(path)
    if (id !== undefined) ids.delete(id)
    index.paths.delete(path)
    index.chains.remove(path)
  }

  /** Invalidate accepted metadata while retaining only identity and rights facts for recovery checks. */
  function invalidate(store: Store): AcceptedTargetIndex {
    const index = target(store), prior = empty(store)
    for (const [path, id] of index.paths) {
      prior.paths.set(path, id)
      prior.chains.putChain(index.chains.get(path)!)
    }
    for (const path of prior.paths.keys()) remove(store, path)
    return prior
  }

  /** Composes rights from each logical ancestor's actual target. */
  function chain(path: Path): readonly ChainNode[] {
    const result: ChainNode[] = []
    for (const ancestor of ancestorPaths(path)) {
      const store = resolve(ancestor)
      const index = target(store)
      const physical = current?.(store, ancestor, index.paths.get(ancestor))
      const node = physical === undefined ? index.chains.get(ancestor) : physical === null ? undefined : decodeChainNode(physical)
      const fault = store.storageFault?.(ancestor)
      if (fault !== undefined) {
        result.push({ path: ancestor, types: [], acl: [], hasAcl: false, hasOwner: false,
          invalid: fault.invalid, alerts: [{ path: ancestor, field: '$storage', error: new KernelError(fault.code, 'Uncomputable filesystem node') }] })
        continue
      }
      if (node !== undefined) result.push(node)
    }
    return result
  }

  /** Enumerates logical immediate children across target owners and suppresses shadowed addresses. */
  function* children(path: Path): Iterable<ChainNode> {
    for (const index of targets.values()) for (const child of index.chains.children(path))
      if (resolve(child.path) === index.store) yield child
  }

  /** Finds owner grants through the composed logical chain, including ancestors in other Stores. */
  function* ownerGrants(): Iterable<Path> {
    for (const index of targets.values()) for (const path of index.chains.grants({ owner: true }))
      if (resolve(path) === index.store) yield path
  }

  /** Combines direct and inherited owner grants for a real node principal. */
  function* grantsTo(principal: Principal): Iterable<Path> {
    const result = new Set<Path>()
    for (const index of targets.values()) for (const path of index.chains.grants({ group: principal }))
      if (resolve(path) === index.store) result.add(path)
    for (const path of ownerGrants()) {
      let owner: Principal | undefined
      for (const node of chain(path)) if (node.hasOwner) owner = node.owner
      if (owner === principal) result.add(path)
    }
    yield* result
  }

  return {
    root: rootIndex,
    target,
    attach,
    prepare,
    detach,
    validate,
    validateGroups,
    validateAttach,
    put,
    remove,
    invalidate,
    chain,
    children,
    grantsTo,
    ownerGrants,
    address: (id: NodeId): AcceptedAddress | undefined => ids.get(id),
  }
}
