import { createTwpHttpRoutes } from '#server/http-routes';
import { randomUUID } from 'node:crypto';
import { collectModule, evaluateModuleFactory, getCollectedModule, getModuleDefinition, instantiateModule, type CollectedModule, type NativeModuleDeployment, type NativeModuleExports, type NativeModuleFactory, type NativeModuleHost } from '#kernel/manifest';
import { installNativeSeeds, type NativeSeedPlan } from '#kernel/seed-install';
import { openNativeRuntime, type NativeRuntimeConfig } from '#kernel/runtime';
import { bindModuleIo, loadAllMods, type LoadResult } from '#mod/loader';
import { KernelError } from '#errors';
import type { ActionIoBinding } from '#kernel/types';

export interface NativeModuleLocation {
  readonly id: string;
  readonly entry: string;
}

export interface NativeDeploymentConfig {
  readonly runtime: Omit<NativeRuntimeConfig, 'modules' | 'io'>;
  /** An explicit list, including an empty list, replaces default discovery. */
  readonly modules?: readonly NativeModuleLocation[];
  readonly modsDir?: string;
  readonly io?: ActionIoBinding;
  readonly seeds?: Omit<NativeSeedPlan, 'opId'>;
}

/** Collect an explicit entry under the same factory and ownership contract as discovered modules. */
async function explicitModule(location: NativeModuleLocation, host: NativeModuleHost): Promise<CollectedModule> {
  const definition = getModuleDefinition(location.id, location.entry);
  if (definition !== undefined) return instantiateModule(definition, host, location.entry);
  const accepted = getCollectedModule(location.id, location.entry);
  if (accepted !== undefined) return accepted;
  let deployment: NativeModuleDeployment | undefined;
  let factory: NativeModuleFactory | undefined;
  return collectModule(location.id, async () => {
    const entry: NativeModuleExports = await import(location.entry);
    factory = entry.default;
    deployment = await evaluateModuleFactory(entry, host);
  }, location.entry, () => deployment, () => factory);
}

/** Open a native deployment; modules and IO are resolved before persistent resources are acquired. */
export async function openNativeDeployment(config: NativeDeploymentConfig) {
  const httpRoutes = createTwpHttpRoutes();
  const host: NativeModuleHost = { httpRoutes };
  let loaded: LoadResult;
  if (config.modules === undefined) {
    loaded = await loadAllMods('kernel', { host, extraDirs: config.modsDir === undefined ? [] : [config.modsDir] });
  } else {
    const manifests: CollectedModule[] = [];
    for (const location of config.modules) manifests.push(await explicitModule(location, host));
    const bindings: ActionIoBinding[] = [];
    for (const manifest of manifests) if (manifest.io !== undefined) bindings.push(manifest.io);
    loaded = { loaded: config.modules.map(location => location.id), failed: [], manifests, io: bindModuleIo(bindings) };
  }
  if (loaded.failed.length > 0)
    throw new AggregateError(loaded.failed.map(failure => failure.error), 'Native module discovery failed');
  const bindings: ActionIoBinding[] = [];
  if (loaded.io !== undefined) bindings.push(loaded.io);
  if (config.io !== undefined) bindings.push(config.io);
  const runtime = await openNativeRuntime({ ...config.runtime, modules: loaded.manifests, io: bindModuleIo(bindings) });
  try {
    if (config.seeds !== undefined) {
      const credential = runtime.instance.setupCredential ?? config.runtime.installerCredential;
      if (credential === undefined) throw new KernelError('FORBIDDEN', 'Seed installation requires the deployment administrator credential');
      const session = await runtime.instance.openSession(credential);
      const lane = session.lane[Symbol.asyncIterator]();
      const welcome = await lane.next();
      if (welcome.done || welcome.value.t !== 'welcome') throw new Error('Installer lane did not open');
      const intake = welcome.value.intake;
      const delivery = (async () => { while (!(await lane.next()).done) {} })();
      try {
        await installNativeSeeds(session, { ...config.seeds,
          opId: { epoch: intake, time: Date.now(), nonce: randomUUID() } });
      } finally { session.close(); await delivery; }
    }
    return { ...runtime, httpRoutes };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
