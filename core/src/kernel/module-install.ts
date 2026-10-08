import { randomUUID } from 'node:crypto'
import { KernelError } from '#errors'
import { bootstrapModules, ownershipRecord, TYPE_PATH } from '#kernel/bootstrap'
import type { InstanceFoundationWithAuth } from '#kernel/instance'
import { createRegistry } from '#kernel/registry'
import { drainSession } from '#kernel/session-delivery'
import type { ChangeMember, Credential, ModuleManifest } from '#kernel/types'

/** Checks configured manifests before provisioning or writing persisted ownership. */
export function previewModules(modules: readonly ModuleManifest[]): void {
  const preview = createRegistry();
  const identities = new Set<string>();
  for (const module of [...bootstrapModules, ...modules]) {
    if (identities.has(module.id)) throw new KernelError('CONFLICT', 'Duplicate configured module');
    identities.add(module.id);
    preview.publish(module);
  }
}

/** Writes type ownership through the installing admin's actual Session before publishing each manifest. */
export async function installModules(
  instance: InstanceFoundationWithAuth,
  modules: readonly ModuleManifest[],
  installerCredential?: Credential,
): Promise<void> {
  const changes: ChangeMember[] = [];
  for (const module of modules)
    for (const type of module.types)
      for (const name of [type.name, ...(type.aliases ?? [])]) {
        const path = `${TYPE_PATH}/${name}`;
        const previous = await instance.source.node(path);
        if (previous !== null) {
          const owner = ownershipRecord(previous);
          if (owner.module !== type.module || owner.security !== type.security)
            throw new KernelError('FORBIDDEN', 'Module differs from persisted type ownership');
        } else {
          changes.push({
            op: 'put',
            node: {
              $path: path,
              $type: 't.type',
              name,
              module: type.module,
              security: type.security,
            },
          });
        }
      }
  const capacity = Math.floor(instance.limits().changeSet);
  if (changes.length > 0) {
    if (capacity < 1)
      throw new KernelError('BUDGET', 'Type ownership installation exceeds the commit limit');
    const credential = instance.setupCredential ?? installerCredential;
    if (credential === undefined)
      throw new KernelError('UNAUTHENTICATED', 'Module installation requires a credential');
    const session = await instance.openSession(credential);
    const delivery = drainSession(session);
    try {
      for (let offset = 0; offset < changes.length; offset += capacity) {
        await session.commit({
          changes: changes.slice(offset, offset + capacity),
          opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
        }).outcome;
      }
    } finally {
      session.close();
      await delivery;
    }
  }
  for (const module of modules) instance.registry.publish(module);
}
