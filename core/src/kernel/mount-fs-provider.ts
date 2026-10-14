import { KernelError } from '#errors'
import { getComponent } from '#core'
import { assertBootstrapState, ownershipRecord, TYPE_PATH } from '#kernel/bootstrap'
import { fsMountType, kernelManifest } from '#kernel/builtins'
import { rawFsMountType } from '#kernel/rawfs-types'
import type { RawFsCodecs } from '#kernel/store/rawfs-codec'
import { componentEntries } from '#kernel/migrate'
import { assertTypeOwner } from '#kernel/module-install'
import { openFsMountTarget } from '#kernel/mount-fs'
import { ownMountTarget } from '#kernel/mount-resource'
import { positionToRev } from '#kernel/position'
import { createRegistry } from '#kernel/registry'
import { assertNodeSchema } from '#kernel/schema'
import { readStoreInitialization } from '#kernel/initialization'
import type { ExternalEdits, ComponentName, InstanceId, MountHandler, ProvisionedStoreMount, Store, StoredNode, Session, Node } from '#kernel/types'
import { stableJson } from '#util/stable-json'

export type FsDirectoryBindings = Readonly<Record<string, string>>

interface PreparedDeclaration {
  readonly node: StoredNode
  readonly component: ComponentName
  readonly directory: string
  readonly external?: ExternalEdits
  readonly rawfs: boolean
}

/** Adopt only the accepted startup resource through its declaring node's session. */
export interface FsMountDeployment {
  readonly instance: InstanceId
  readonly directories: FsDirectoryBindings
  readonly rawfsCodecs?: RawFsCodecs
}

/** Adopt startup resources unchanged; later declarations use only this deployment's directory capabilities. */
export function createFsMountHandler(mounts: readonly ProvisionedStoreMount[], deployment?: FsMountDeployment, type = fsMountType): MountHandler {
  const prepared = new Map(mounts.map(mount => [stableJson([mount.node, mount.component]), mount]))

  async function open(node: Node, session: Session, component: ComponentName) {
    if (session.actor.principal !== `n:${node.$id}`) throw new KernelError('FORBIDDEN', 'Filesystem mount requires its declaring node session')
    const mount = prepared.get(stableJson([node.$id, component]))
    if (mount !== undefined) {
      if (mount.revision !== node.$rev) throw new KernelError('CONFLICT', 'Filesystem mount declaration changed')
      return mount.target
    }
    const declaration = getComponent<{ directory: string; external?: ExternalEdits }>(node, type.name, component)
    if (declaration === undefined) throw new KernelError('INVALID', 'Filesystem mount declaration is absent')
    if (deployment === undefined || !Object.hasOwn(deployment.directories, declaration.directory))
      throw new KernelError('UNAVAILABLE', 'Filesystem directory capability is unavailable')
    return openFsMountTarget({ directory: deployment.directories[declaration.directory], instance: deployment.instance,
      logicalBase: node.$path, external: declaration.external,
      rawfsCodecs: type === rawFsMountType ? deployment.rawfsCodecs ?? {} : undefined })
  }

  return Object.assign(open, { async prepare(node: Node, component: ComponentName, owner?: import('#kernel/types').MountPreparation) {
    if (owner === undefined) throw new KernelError('UNAVAILABLE', 'Filesystem preparation requires its accepted declaring session')
    return open(node, await owner.openSession(), component)
  } })
}

/** Validate the complete accepted census before acquiring any configured host-directory authority. */
export async function provisionFsMounts(
  root: Store,
  instance: InstanceId,
  bindings: FsDirectoryBindings,
  rawfsCodecs: RawFsCodecs = {},
): Promise<readonly ProvisionedStoreMount[]> {
  const { metadata, nodes } = await readStoreInitialization(root, new Set([fsMountType.name, rawFsMountType.name]))
  if (metadata.length === 0) return []
  assertBootstrapState(instance, nodes)

  const registry = createRegistry()
  registry.publish(kernelManifest)
  const declarations: PreparedDeclaration[] = []

  for (const node of nodes.values()) for (const [component, value] of componentEntries(node)) {
    if (value.$type !== fsMountType.name && value.$type !== rawFsMountType.name) continue
    const type = value.$type === fsMountType.name ? fsMountType : rawFsMountType
    const owner = nodes.get(`${TYPE_PATH}/${type.name}`)
    if (owner === undefined) throw new KernelError('UNAVAILABLE', 'Filesystem mount type is not installed')
    assertTypeOwner(ownershipRecord(owner), type)
    assertNodeSchema(value, registry)
    const directory = value.directory
    if (typeof directory !== 'string') throw new KernelError('INVALID', 'Malformed filesystem mount directory binding')
    if (!Object.hasOwn(bindings, directory)) throw new KernelError('UNAVAILABLE', 'Filesystem directory capability is unavailable')
    declarations.push({ node, component, directory: bindings[directory], external: value.external === 'trusted' ? 'trusted' : undefined, rawfs: type === rawFsMountType })
  }

  const mounts: ProvisionedStoreMount[] = []
  try {
    for (const declaration of declarations) {
      const target = ownMountTarget(await openFsMountTarget({
        directory: declaration.directory,
        instance,
        logicalBase: declaration.node.$path,
        external: declaration.external,
        rawfsCodecs: declaration.rawfs ? rawfsCodecs : undefined,
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
