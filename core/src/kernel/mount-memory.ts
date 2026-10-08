import { randomUUID } from 'node:crypto'

import { KernelError } from '#errors'
import { kernelManifest } from '#kernel/builtins'
import { createMemoryStore } from '#kernel/store/memory'
import type { ModuleManifest, MountHandler, OpenedStoreMountTarget } from '#kernel/types'

export type MemoryMountHandler = (...args: Parameters<MountHandler>) => Promise<OpenedStoreMountTarget>

/** Bind the actual in-process Writer token to genuinely new memory targets. */
export function createMemoryMountHandler(writerEpoch: number): MemoryMountHandler {
  if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 0) {
    throw new KernelError('INVALID', 'Invalid memory mount writer epoch')
  }

  return async () => {
    const store = createMemoryStore({ domain: `memory:${randomUUID()}` })

    return {
      kind: 'store',
      store,
      resources: {
        writerEpoch,
        epoch: randomUUID(),
        persistent: false,
        decisionHistory: 'fresh',
      },
      async close(): Promise<void> {
        store.close()
      },
    }
  }
}

/** Publish the kernel-owned handler with one instance's acquired Writer token. */
export function createMemoryMountManifest(writerEpoch: number): ModuleManifest {
  return {
    ...kernelManifest,
    security: [
      ...kernelManifest.security,
      { type: 't.mount.memory', context: 'mount', handler: createMemoryMountHandler(writerEpoch) },
    ],
  }
}
