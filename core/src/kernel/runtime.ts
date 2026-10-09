import { join } from 'node:path'
import { KernelError } from '#errors'
import { createInstance, type InstanceFoundationWithAuth } from '#kernel/instance'
import { openPersistentWriter } from '#kernel/persistence'
import { copyManifest } from '#kernel/registry'
import { previewModules } from '#kernel/module-install'
import { provisionFsMounts, type FsDirectoryBindings } from '#kernel/mount-fs-provider'
import { createFsStore } from '#kernel/store/fs'
import { createFsBlobStore } from '#kernel/blob-store-fs'
import { DEFAULT_LIMITS, type ActionIoBinding, type AdminInput, type Credential, type Gate, type ModuleManifest, type ProvisionedStoreMount } from '#kernel/types'

export interface NativeRuntimeConfig {
  readonly io?: ActionIoBinding
  readonly id: string
  readonly directory: string
  readonly credentialTtlMs: number
  readonly firstAdmin?: AdminInput
  readonly installerCredential?: Credential
  /** This deployment binding supplies configured manifests; omission selects an empty set. */
  readonly modules?: readonly ModuleManifest[]
  readonly gates?: readonly Gate[]
  /** Named host-directory capabilities; declarations hold names rather than filesystem paths. */
  readonly mountDirectories?: FsDirectoryBindings
}

/** Opens a filesystem-backed instance, installs its modules, and owns its resources. */
export async function openNativeRuntime(input: NativeRuntimeConfig) {
  const modules = (input.modules ?? []).map(copyManifest),
    firstAdmin =
      input.firstAdmin === undefined ? undefined : Object.freeze({ ...input.firstAdmin });
  const config = Object.freeze({
    id: input.id,
    io: input.io,
    directory: input.directory,
    credentialTtlMs: input.credentialTtlMs,
    installerCredential:
      input.installerCredential === undefined
        ? undefined
        : Object.freeze({ ...input.installerCredential }),
    gates: Object.freeze([...(input.gates ?? [])]),
    mountDirectories: Object.freeze({ ...input.mountDirectories }),
  });
  if (!Number.isFinite(config.credentialTtlMs) || config.credentialTtlMs <= 0)
    throw new KernelError('INVALID', 'Credential lifetime must be positive and finite');
  previewModules(modules);
  const lease = await openPersistentWriter({
    directory: join(config.directory, '.treenix'),
    instance: config.id,
  });
  let store: Awaited<ReturnType<typeof createFsStore>>;
  try {
    store = await createFsStore({ directory: config.directory, lease });
  } catch (error) {
    await lease.close();
    throw error;
  }
  let foundation: InstanceFoundationWithAuth | undefined;
  let mounts: readonly ProvisionedStoreMount[] = [];
  /** Release instance, store, and writer resources in ownership order. */
  async function release(): Promise<void> {
    const errors: unknown[] = [];
    try { await foundation?.close(); } catch (error) { console.error(error); errors.push(error); }

    const closed = await Promise.allSettled(mounts.map(mount => mount.target.close()));
    for (const result of closed) if (result.status === 'rejected') {
      console.error(result.reason); errors.push(result.reason);
    }

    try { await store.close(); } catch (error) { console.error(error); errors.push(error); }
    try { await lease.close(); } catch (error) { console.error(error); errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Native runtime resource release failed');
  }
  try {
    const existing = await store.scan({
      range: { node: '/' },
      budget: {
        nodes: 1,
        bytes: DEFAULT_LIMITS.readBytes,
        exprWork: DEFAULT_LIMITS.exprWork,
        deadline: Date.now() + DEFAULT_LIMITS.queryMs,
      },
    });

    mounts = await provisionFsMounts(store, config.id, config.mountDirectories);
    // A retained tail cannot prove that every earlier accepted decision still exists.
    await lease.renewContinuity();

    foundation = await createInstance({
      id: config.id,
      root: { kind: 'store', store },
      blobs: await createFsBlobStore(join(config.directory, '.treenix', 'blobs')),
      provisioning: {
        counter: lease,
        writerEpoch: lease.writerEpoch,
        domains: [{ store, epoch: lease.epoch, persistent: true }],
        mounts,
        credentialTtlMs: config.credentialTtlMs,
        bootstrap: existing.items.length === 0 && firstAdmin !== undefined
          ? { kind: 'fresh', admin: firstAdmin }
          : { kind: 'reopen', installerCredential: config.installerCredential },
      },
      gates: config.gates,
      io: config.io,
      modules,
    });
    let closing: Promise<void> | undefined;
    return {
      instance: foundation,
      store,
      /** Close the instance and persistent resources once. */
      close() {
        return (closing ??= release());
      },
    };
  } catch (error) {
    console.error(error);
    try { await release(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native runtime construction and release failed');
    }
    throw error;
  }
}
