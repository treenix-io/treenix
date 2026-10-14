import { createTwpHttpRoutes } from '#server/http-routes';
import { randomUUID } from 'node:crypto';
import { evaluateModuleFactory,materializeModule,type CollectedModule,type NativeModuleExports,type NativeModuleHost } from '#kernel/manifest';
import type { NativeSeedDefinition } from '#mod/native-prefab';
import type { InstanceFoundationWithAuth } from '#kernel/instance';
import { openNativeRuntime,type NativeRuntimeConfig } from '#kernel/runtime';
import { bindModuleIo,loadAllMods,moduleGates,type LoadResult } from '#mod/loader';
import { KernelError } from '#errors';
import { createLogsInput } from '#mods/logs/input';
import { provisionLogs } from '#mods/logs/provision';
import type { ActionIoBinding } from '#kernel/types';

export interface NativeModuleLocation {
  readonly id: string;
  readonly entry: string;
}

export interface PersistentLogsConfig { readonly directory: string }

export type NativeDeploymentHost = Omit<NativeModuleHost, 'httpRoutes' | 'logs'>;

export interface NativeDeploymentConfig {
  readonly runtime: Omit<NativeRuntimeConfig, 'modules' | 'io' | 'initialize'>;
  /** An explicit list, including an empty list, replaces default discovery. */
  readonly modules?: readonly NativeModuleLocation[];
  /** Package entries supplement module discovery without replacing its owners. */
  readonly additionalModules?: readonly NativeModuleLocation[];
  /** External capabilities supplement the deployment-owned HTTP routes and log input. */
  readonly host?: NativeDeploymentHost;
  readonly modsDir?: string;
  /** Explicit host-package module directories supplement the selected data folder. */
  readonly moduleDirectories?: readonly string[];
  readonly io?: ActionIoBinding;
  readonly seeds?: NativeSeedDefinition;
  readonly seedFilter?: readonly string[];
  /** Explicit host-directory capability name; no filesystem authority is stored in log nodes. */
  readonly persistentLogs?: PersistentLogsConfig;
}

/** Collect an explicit entry under the same factory and ownership contract as discovered modules. */
async function explicitModule(location: NativeModuleLocation, host: NativeModuleHost): Promise<CollectedModule> {
  const entry: NativeModuleExports = await import(location.entry);
  return materializeModule(location.id, await evaluateModuleFactory(entry, host));
}

/** Open a native deployment; modules and IO are resolved before persistent resources are acquired. */
export async function openNativeDeployment(config: NativeDeploymentConfig) {
  const httpRoutes = createTwpHttpRoutes();
  const logs = createLogsInput();
  const host: NativeModuleHost = { ...config.host, httpRoutes, logs };
  let loaded: LoadResult;
  if (config.modules === undefined) {
    loaded = await loadAllMods('kernel', { host, extraDirs: [
      ...(config.moduleDirectories ?? []), ...(config.modsDir === undefined ? [] : [config.modsDir]),
    ] });
  } else {
    const manifests: CollectedModule[] = [];
    for (const location of config.modules) manifests.push(await explicitModule(location, host));
    loaded = { loaded: config.modules.map(location => location.id), failed: [], manifests };
  }
  if (loaded.failed.length > 0)
    throw new AggregateError(loaded.failed.map(failure => failure.error), 'Native module discovery failed');
  for (const location of config.additionalModules ?? []) {
    loaded.manifests.push(await explicitModule(location, host));
    loaded.loaded.push(location.id);
  }
  loaded.io = bindModuleIo(loaded.manifests.flatMap(module => module.io === undefined ? [] : [module.io]));
  loaded.gates = moduleGates(loaded.manifests);
  if (config.seeds !== undefined && config.seedFilter !== undefined)
    throw new KernelError('INVALID', 'Choose an explicit seed plan or named module seeds');
  const installers = loaded.manifests.flatMap(module => module.seedInstaller === undefined ? [] : [module.seedInstaller]);
  if (installers.length > 1) throw new KernelError('CONFLICT', 'Seed installation has multiple module owners');
  const installer = installers[0];

  /** Require the module-owned installer only when this deployment selects seed data. */
  function seedOwner() {
    if (installer === undefined) throw new KernelError('UNAVAILABLE', 'Seed installation requires its native module');
    return installer;
  }

  const seeds = config.seedFilter === undefined ? config.seeds : seedOwner().select(loaded.manifests, config.seedFilter);
  if (seeds !== undefined) seedOwner().assert(seeds);

  const bindings: ActionIoBinding[] = [];
  if (loaded.io !== undefined) bindings.push(loaded.io);
  if (config.io !== undefined) bindings.push(config.io);
  const rawfsCodecs = { ...config.runtime.rawfsCodecs };
  for (const module of loaded.manifests) for (const [mime, codec] of Object.entries(module.rawfsCodecs ?? {})) {
    if (Object.hasOwn(rawfsCodecs, mime)) throw new KernelError('CONFLICT', `Raw file codec has multiple owners: ${mime}`);
    rawfsCodecs[mime] = codec;
  }

  /** Publish seed state before any autostart session captures its mutation intake. */
  async function initialize(instance: InstanceFoundationWithAuth): Promise<void> {
    if (seeds !== undefined || config.persistentLogs !== undefined) {
      const credential = instance.setupCredential ?? config.runtime.installerCredential
        ?? (config.runtime.firstAdmin === undefined ? undefined : await instance.auth.login({
          account: config.runtime.firstAdmin.path, password: config.runtime.firstAdmin.password }));
      if (credential === undefined) throw new KernelError('FORBIDDEN', 'Seed installation requires the deployment administrator credential');
      const session = await instance.openSession(credential);
      const lane = session.lane[Symbol.asyncIterator]();
      const welcome = await lane.next();
      if (welcome.done || welcome.value.t !== 'welcome') throw new Error('Installer lane did not open');
      let intake = welcome.value.intake;
      const delivery = (async () => {
        for (;;) {
          const next = await lane.next();
          if (next.done) return;
          if (next.value.t === 'end') throw next.value.error;
          if (next.value.t === 'pos' && next.value.coverage !== true && next.value.intake !== undefined) intake = next.value.intake;
        }
      })();
      try {
        if (seeds !== undefined) await seedOwner().install(session, { ...seeds,
          opId: { epoch: intake, time: Date.now(), nonce: randomUUID() } });
        if (config.persistentLogs !== undefined) await provisionLogs(session, config.persistentLogs.directory,
          () => ({ epoch: intake, time: Date.now(), nonce: randomUUID() }));
      } finally { session.close(); await delivery; }
    }
  }

  const runtime = await openNativeRuntime({ ...config.runtime, initialize, rawfsCodecs, modules: loaded.manifests, io: bindModuleIo(bindings),
    gates: [...(loaded.gates ?? []), ...(config.runtime.gates ?? [])] });
  try {
    logs.emit({ t: Date.now(), level: 'info', sub: 'native-deployment', msg: 'Native deployment opened' });
    return { ...runtime, httpRoutes, logs };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
