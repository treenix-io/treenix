import { join } from 'node:path'

import { openPersistentWriter, type PersistentWriter } from '#kernel/persistence'
import { createFsStore, type FsStore } from '#kernel/store/fs'
import type { InstanceId, OpenedStoreMountTarget, Path } from '#kernel/types'

export interface FsMountTargetOptions {
  readonly directory: string
  readonly instance: InstanceId
  readonly logicalBase: Path
}

export type FsMountTarget = OpenedStoreMountTarget & { readonly store: FsStore }

/** Release storage before its lease, retaining failures from either owned resource. */
async function closeResources(lease: PersistentWriter, store?: FsStore): Promise<void> {
  const errors: unknown[] = []

  if (store !== undefined) {
    try {
      await store.close()
    } catch (error) {
      console.error(error)
      errors.push(error)
    }
  }

  try {
    await lease.close()
  } catch (error) {
    console.error(error)
    errors.push(error)
  }

  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Filesystem mount resource release failed')
}

/** Acquire actual storage authority; unknown journal continuity forces a durable stream reset. */
export async function openFsMountTarget(options: FsMountTargetOptions): Promise<FsMountTarget> {
  const { directory, instance, logicalBase } = options
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance })
  let store: FsStore | undefined

  try {
    store = await createFsStore({ directory, lease, logicalBase })
    const epoch = await lease.renewContinuity()
    const acquiredStore = store
    let closing: Promise<void> | undefined

    /** All owners await the same release, including concurrent failed activation cleanup. */
    function close(): Promise<void> {
      return closing ??= closeResources(lease, acquiredStore)
    }

    return {
      kind: 'store',
      store,
      resources: { writerEpoch: lease.writerEpoch, epoch, persistent: true, decisionHistory: 'unconfirmed' },
      close,
    }
  } catch (error) {
    console.error(error)

    try {
      await closeResources(lease, store)
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Filesystem mount initialization and release failed')
    }

    throw error
  }
}
