import { KernelError } from '#errors';
import { copyManifest } from '#kernel/registry';
import type { ActionIoBinding, Gate, ModuleManifest, Registry, Session } from '#kernel/types';
import type { NativeSeedDefinition, NativeSeedPlan } from '#mod/native-prefab';
import type { RawFsCodecs } from '#kernel/store/rawfs-codec';

export interface NativeSeedInstaller {
  select(
    modules: readonly { readonly seeds?: NativeSeedDefinition }[],
    names: readonly string[],
  ): NativeSeedDefinition;
  assert(plan: NativeSeedDefinition): void;
  install(
    session: Session,
    plan: NativeSeedPlan,
  ): Promise<{ readonly installed: readonly string[]; readonly skipped: readonly string[] }>;
}

export interface NativeModuleDeployment {
  readonly manifest: ModuleManifest;
  readonly io?: ActionIoBinding;
  readonly gates?: readonly Gate[];
  readonly seeds?: NativeSeedDefinition;
  readonly seedInstaller?: NativeSeedInstaller;
  readonly rawfsCodecs?: RawFsCodecs;
}
/** Host capabilities are declared by their owning deployment bindings. */
export interface NativeModuleHost {}
export type NativeModuleFactory = (
  host: NativeModuleHost,
) => NativeModuleDeployment | Promise<NativeModuleDeployment>;

export interface NativeModuleExports {
  readonly default?: NativeModuleFactory;
}

/** Native entries supply their factory; module import caching belongs to the JavaScript loader. */
export async function evaluateModuleFactory(
  entry: NativeModuleExports,
  host: NativeModuleHost = {},
): Promise<NativeModuleDeployment> {
  if (typeof entry.default !== 'function')
    throw new KernelError('INVALID', 'Native module entry requires a callable factory');
  return entry.default(host);
}

export interface CollectedModule extends ModuleManifest {
  readonly collectionId?: string;
  readonly io?: ActionIoBinding;
  readonly gates?: readonly Gate[];
  readonly seeds?: NativeSeedDefinition;
  readonly seedInstaller?: NativeSeedInstaller;
  readonly rawfsCodecs?: RawFsCodecs;
}

export interface NativeModuleDefinition {
  readonly collectionId: string;
  readonly factory: NativeModuleFactory;
}

export function isSecurityContext(
  context: string,
): context is 'acl' | 'migrate' | 'mount' | 'service' | 'derive' {
  return (
    context === 'acl' ||
    context === 'migrate' ||
    context === 'mount' ||
    context === 'service' ||
    context === 'derive'
  );
}

/** Snapshot only explicit declarations and keep deployment resources owned by this invocation. */
export function materializeModule(
  collectionId: string,
  deployment: NativeModuleDeployment,
): CollectedModule {
  return Object.freeze({
    ...copyManifest(deployment.manifest),
    collectionId,
    io: deployment.io,
    seeds: deployment.seeds,
    seedInstaller: deployment.seedInstaller,
    rawfsCodecs: deployment.rawfsCodecs,
    gates: deployment.gates === undefined ? undefined : Object.freeze([...deployment.gates]),
  });
}

/** A cached import supplies the same factory code; each host gets its own fresh deployment. */
export async function instantiateModule(
  definition: NativeModuleDefinition,
  host: NativeModuleHost,
): Promise<CollectedModule> {
  return materializeModule(
    definition.collectionId,
    await evaluateModuleFactory({ default: definition.factory }, host),
  );
}

export function publishModules(registry: Registry, manifests: readonly CollectedModule[]): void {
  const identities = new Set<string>();
  for (const manifest of manifests) {
    if (identities.has(manifest.id))
      throw new KernelError('CONFLICT', `Duplicate module identity: ${manifest.id}`);
    identities.add(manifest.id);
  }
  for (const manifest of manifests) registry.publish(manifest);
}
