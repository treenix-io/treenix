import { join } from 'node:path'
import { KernelError } from '#errors'
import type { AdminInput } from '#kernel/auth-module'
import { createInstanceFoundation, type InstanceFoundationWithAuth } from '#kernel/instance'
import { openPersistentWriter } from '#kernel/persistence'
import { copyManifest } from '#kernel/registry'
import { installModules, previewModules } from '#kernel/module-install'
import { createFsStore } from '#kernel/store/fs'
import { createFsBlobStore } from '#kernel/blob-store-fs'
import { DEFAULT_LIMITS, type Credential, type Gate, type ModuleManifest } from '#kernel/types'

export interface NativeRuntimeConfig {
  readonly id: string
  readonly directory: string
  readonly credentialTtlMs: number
  readonly firstAdmin?: AdminInput
  readonly installerCredential?: Credential
  readonly modules?: readonly ModuleManifest[]
  readonly gates?: readonly Gate[]
}

/** Opens a filesystem-backed instance, installs its modules, and owns its resources. */
export async function openNativeRuntime(input: NativeRuntimeConfig) {
  const modules = (input.modules ?? []).map(copyManifest),
    firstAdmin =
      input.firstAdmin === undefined ? undefined : Object.freeze({ ...input.firstAdmin });
  const config = Object.freeze({
    id: input.id,
    directory: input.directory,
    credentialTtlMs: input.credentialTtlMs,
    installerCredential:
      input.installerCredential === undefined
        ? undefined
        : Object.freeze({ ...input.installerCredential }),
    gates: Object.freeze([...(input.gates ?? [])]),
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
  /** Release instance, store, and writer resources in ownership order. */
  async function release(): Promise<void> {
    foundation?.close();
    try {
      await store.close();
    } finally {
      await lease.close();
    }
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
    foundation = await createInstanceFoundation({
      id: config.id,
      root: store,
      writerEpoch: lease.writerEpoch,
      blobs: await createFsBlobStore(join(config.directory, '.treenix', 'blobs')),
      counter: lease,
      domains: [{ store, epoch: lease.epoch, persistent: true }],
      gates: config.gates,
      initialCredential: { ttlMs: config.credentialTtlMs },
      ...(existing.items.length === 0 && firstAdmin !== undefined ? { firstAdmin } : {}),
    });
    await installModules(foundation, modules, config.installerCredential);
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
    await release();
    throw error;
  }
}
