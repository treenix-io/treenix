import { createFsMountHandler } from '#kernel/mount-fs-provider'
import { createMemoryMountManifest } from '#kernel/mount-memory'
import type { ModuleManifest, ProvisionedStoreMount } from '#kernel/types'

/** Bind built-in mount handlers to the actual resources acquired for this instance. */
export function createNativeMountManifest(writerEpoch: number, mounts: readonly ProvisionedStoreMount[] = []): ModuleManifest {
  const manifest = createMemoryMountManifest(writerEpoch)
  return {
    ...manifest,
    security: [
      ...manifest.security,
      { type: 't.mount.fs', context: 'mount', handler: createFsMountHandler(mounts) },
    ],
  }
}
