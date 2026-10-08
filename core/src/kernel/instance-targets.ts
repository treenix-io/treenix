import { ancestorPaths } from '#core/path'
import { KernelError } from '#errors'
import { createChainIndex } from '#kernel/chain-index'
import type { ChainNode } from '#kernel/rights'
import type { NodeId, Path, Principal, Store, StoredNode } from '#kernel/types'

export interface AcceptedTargetIndex {
  readonly store: Store
  readonly paths: Map<Path, NodeId>
  readonly chains: ReturnType<typeof createChainIndex>
}

export interface AcceptedAddress {
  readonly store: Store
  readonly path: Path
}

/** Indexes accepted identities and rights without retaining node bodies outside the process cache. */
export function createAcceptedTargets(root: Store, resolve: (path: Path) => Store) {
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

  /** Refuses metadata collisions before acquiring Writer publication authority. */
  function validateAttach(store: Store, nodes: readonly StoredNode[]): void {
    if (targets.has(store)) throw new KernelError('INVALID', 'Store metadata is already registered')
    const changed = new Map<Path, StoredNode>()
    for (const node of nodes) {
      if (changed.has(node.$path)) throw new KernelError('INVALID', 'Duplicate accepted Store path')
      changed.set(node.$path, node)
    }
    validate(store, changed)
  }

  /** Installs a fully prepared Store index before its routing becomes visible. */
  function attach(store: Store, nodes: readonly StoredNode[]): AcceptedTargetIndex {
    validateAttach(store, nodes)

    const index = empty(store)
    for (const node of nodes) {
      index.paths.set(node.$path, node.$id)
      index.chains.put(node)
    }

    targets.set(store, index)
    for (const node of nodes) ids.set(node.$id, { store, path: node.$path })
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

  /** Composes rights from each logical ancestor's actual target. */
  function chain(path: Path): readonly ChainNode[] {
    const result: ChainNode[] = []
    for (const ancestor of ancestorPaths(path)) {
      const node = target(resolve(ancestor)).chains.get(ancestor)
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
    detach,
    validate,
    validateAttach,
    put,
    remove,
    chain,
    children,
    grantsTo,
    ownerGrants,
    address: (id: NodeId): AcceptedAddress | undefined => ids.get(id),
  }
}
