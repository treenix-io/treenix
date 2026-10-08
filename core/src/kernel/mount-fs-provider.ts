import { KernelError } from '#errors'
import { assertBootstrapState, ownershipRecord, TYPE_PATH } from '#kernel/bootstrap'
import { fsMountType, kernelManifest } from '#kernel/builtins'
import { componentEntries } from '#kernel/migrate'
import { assertTypeOwner } from '#kernel/module-install'
import { openFsMountTarget } from '#kernel/mount-fs'
import { ownMountTarget } from '#kernel/mount-resource'
import { positionToRev } from '#kernel/position'
import { createRegistry } from '#kernel/registry'
import { assertNodeSchema } from '#kernel/schema'
import { runStoreQuery } from '#kernel/store/budget'
import { DEFAULT_LIMITS, type ComponentName, type InstanceId, type MountHandler, type ProvisionedStoreMount, type Store, type StoredNode } from '#kernel/types'
import { stableJson } from '#util/stable-json'

export type FsDirectoryBindings = Readonly<Record<string, string>>

interface PreparedDeclaration {
  readonly node: StoredNode
  readonly component: ComponentName
  readonly directory: string
}

/** Adopt only the accepted startup resource through its declaring node's session. */
export function createFsMountHandler(mounts: readonly ProvisionedStoreMount[]): MountHandler {
  const prepared = new Map(mounts.map(mount => [stableJson([mount.node, mount.component]), mount]))

  return async (node, session) => {
    const component = componentEntries(node).find(([, value]) => value.$type === fsMountType.name)
    const mount = component === undefined ? undefined : prepared.get(stableJson([node.$id, component[0]]))
    if (mount === undefined) throw new KernelError('UNAVAILABLE', 'Filesystem mount requires startup provisioning')
    if (mount.revision !== node.$rev) throw new KernelError('CONFLICT', 'Filesystem mount declaration changed')
    if (session.actor.principal !== `n:${node.$id}`) throw new KernelError('FORBIDDEN', 'Filesystem mount requires its declaring node session')
    return mount.target
  }
}

/** Validate the complete accepted census before acquiring any configured host-directory authority. */
export async function provisionFsMounts(
  root: Store,
  instance: InstanceId,
  bindings: FsDirectoryBindings,
): Promise<readonly ProvisionedStoreMount[]> {
  const budget = {
    nodes: DEFAULT_LIMITS.readNodes,
    bytes: DEFAULT_LIMITS.readBytes,
    exprWork: DEFAULT_LIMITS.exprWork,
    deadline: Date.now() + DEFAULT_LIMITS.queryMs,
  }
  const scanned = await runStoreQuery(budget, DEFAULT_LIMITS.queryMs,
    allowance => root.scan({ range: { subtree: '/' }, budget: allowance }))
  if (scanned.items.length === 0) return []

  const nodes = new Map(scanned.items.map(node => [node.$path, node]))
  assertBootstrapState(instance, nodes)

  const registry = createRegistry()
  registry.publish(kernelManifest)
  const declarations: PreparedDeclaration[] = []

  for (const node of scanned.items) for (const [component, value] of componentEntries(node)) {
    if (value.$type !== fsMountType.name) continue
    const owner = nodes.get(`${TYPE_PATH}/${fsMountType.name}`)
    if (owner === undefined) throw new KernelError('UNAVAILABLE', 'Filesystem mount type is not installed')
    assertTypeOwner(ownershipRecord(owner), fsMountType)
    assertNodeSchema(value, registry)
    const directory = value.directory
    if (typeof directory !== 'string') throw new KernelError('INVALID', 'Malformed filesystem mount directory binding')
    if (!Object.hasOwn(bindings, directory)) throw new KernelError('UNAVAILABLE', 'Filesystem directory capability is unavailable')
    declarations.push({ node, component, directory: bindings[directory] })
  }

  const mounts: ProvisionedStoreMount[] = []
  try {
    for (const declaration of declarations) {
      const target = ownMountTarget(await openFsMountTarget({
        directory: declaration.directory,
        instance,
        logicalBase: declaration.node.$path,
      }))
      mounts.push(Object.freeze({ node: declaration.node.$id, component: declaration.component,
        revision: positionToRev(declaration.node.$pos), target }))
    }
    return mounts
  } catch (error) {
    console.error(error)
    const closed = await Promise.allSettled(mounts.map(mount => mount.target.close()))
    const errors: unknown[] = [error]
    for (const result of closed) if (result.status === 'rejected') {
      console.error(result.reason)
      errors.push(result.reason)
    }
    if (errors.length > 1)
      throw new AggregateError(errors, 'Filesystem mount provisioning and release failed')
    throw error
  }
}
