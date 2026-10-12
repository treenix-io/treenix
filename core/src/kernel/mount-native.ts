import { createFederationMountHandler } from '#kernel/mount-federation'
import { createFsMountHandler, type FsMountDeployment } from '#kernel/mount-fs-provider'
import { rawFsMountType } from '#kernel/rawfs-types'
import { createMemoryMountManifest } from '#kernel/mount-memory'
import { queryMountHandler } from '#kernel/query'
import type { FederationBinding, Limits, ModuleManifest, ProvisionedStoreMount } from '#kernel/types'

/** Bind built-in mount handlers to the actual resources acquired for this instance. */
export function createNativeMountManifest(writerEpoch: number, mounts: readonly ProvisionedStoreMount[] = [], limits?: () => Limits, federation?: FederationBinding, filesystem?: FsMountDeployment): ModuleManifest {
  const manifest = createMemoryMountManifest(writerEpoch)
  return {
    ...manifest,
    security: [
      ...manifest.security,
      { type: 't.mount.federation', context: 'mount', handler: createFederationMountHandler(federation, limits) },
      { type: 't.mount.query', context: 'mount', handler: queryMountHandler },
      { type: 't.mount.fs', context: 'mount', handler: createFsMountHandler(mounts, filesystem) },
      { type: 't.mount.rawfs', context: 'mount', handler: createFsMountHandler(mounts, filesystem, rawFsMountType) },
    ],
  }
}
