import type { ActionIoBinding, AdminInput } from '#kernel/types'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeJsonParse } from '#core/json'
import { KernelError } from '#errors'
import { openNativeDeployment, type NativeDeploymentHost, type NativeModuleLocation, type PersistentLogsConfig } from '#server/native-deployment'
import type { FsDirectoryBindings } from '#kernel/mount-fs-provider'
import type { Credential } from '#kernel/types'
import { createTwpHttpServer } from '#server/http-twp'
import { isRecord } from '#util/is-record'
import { nativeRootStorage } from '#server/native-root'

interface DeploymentEntry { readonly entry: string }
interface CapabilityEntry {
  createModuleHost(instance: string): NativeDeploymentHost | Promise<NativeDeploymentHost>;
}
/** Decode the deployment entry before acquiring persistent runtime resources. */
function deploymentEntry(value: unknown): value is DeploymentEntry {
  return isRecord(value) && typeof value.entry === 'string' && value.entry.length > 0
}

function persistentLogsInput(value: unknown): value is PersistentLogsConfig {
  return isRecord(value) && typeof value.directory === 'string' && value.directory.length > 0
}

interface ModuleEntry { readonly id: string; readonly entry: string }
function moduleEntry(value: unknown): value is ModuleEntry {
  return isRecord(value) && typeof value.id === 'string' && typeof value.entry === 'string'
}
function adminInput(value: unknown): value is AdminInput {
  return isRecord(value) && typeof value.path === 'string' && typeof value.name === 'string' && typeof value.password === 'string'
}
function credentialInput(value: unknown): value is Credential {
  return isRecord(value) && typeof value.token === 'string'
}

/** Decode host-directory capabilities before any runtime resource is acquired. */
function directoryBindings(value: unknown): value is FsDirectoryBindings {
  return isRecord(value) && Object.values(value).every(directory => typeof directory === 'string' && directory.length > 0)
}

/** Validate CLI configuration, acquire native runtime resources, and serve until shutdown. */
async function main(): Promise<void> {
  const [argument, option, deployment, ...extra] = process.argv.slice(2)
  if (argument === undefined) throw new KernelError('INVALID', 'Use npm run dev:kernel -- path/to/kernel-config.json')
  if (option !== undefined && (option !== '--deployment' || deployment === undefined) || extra.length !== 0)
    throw new KernelError('INVALID', 'Use root.json --deployment path/to/kernel-config.json')

  const configPath = resolve(deployment ?? argument)
  const input: unknown = safeJsonParse(await readFile(configPath, 'utf8'))
  if (!isRecord(input)) throw new KernelError('INVALID', 'Malformed native server configuration')

  const storage = deployment === undefined ? undefined
    : nativeRootStorage(safeJsonParse(await readFile(resolve(argument), 'utf8')), process.cwd())
  if (storage !== undefined && (input.directory !== undefined || input.baseDirectory !== undefined || input.seedFilter !== undefined))
    throw new KernelError('INVALID', 'Root storage and seeds must be configured only in root.json')

  const config: Record<string, unknown> = { ...input, ...storage }
  if (typeof config.id !== 'string' || typeof config.directory !== 'string' || typeof config.credentialTtlMs !== 'number'
    || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.every((value: unknown): value is string => typeof value === 'string')
    || config.firstAdmin !== undefined && !adminInput(config.firstAdmin)
    || config.installerCredential !== undefined && !credentialInput(config.installerCredential)
    || config.persistentLogs !== undefined && !persistentLogsInput(config.persistentLogs)
    || config.io !== undefined && !deploymentEntry(config.io)
    || config.capabilities !== undefined && !deploymentEntry(config.capabilities)
    || config.baseDirectory !== undefined && (typeof config.baseDirectory !== 'string' || config.baseDirectory.length === 0)
    || config.mountDirectories !== undefined && !directoryBindings(config.mountDirectories)
    || config.seedFilter !== undefined && (!Array.isArray(config.seedFilter)
      || !config.seedFilter.every((name: unknown): name is string => typeof name === 'string'))
    || config.modules !== undefined && (!Array.isArray(config.modules) || !config.modules.every(moduleEntry))
    || config.additionalModules !== undefined && (!Array.isArray(config.additionalModules) || !config.additionalModules.every(moduleEntry)))
    throw new KernelError('INVALID', 'Malformed native server configuration')
  const port = config.port ?? 4882, host = config.host ?? '127.0.0.1'
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 0 || port > 65535 || typeof host !== 'string')
    throw new KernelError('INVALID', 'Malformed native listen address')
  /** Resolve deployment-owned package locations from the configuration directory. */
  function moduleLocations(entries: ModuleEntry[] | undefined): readonly NativeModuleLocation[] | undefined {
    return entries?.map(entry => ({
      id: entry.id,
      entry: entry.entry.startsWith('.') || entry.entry.startsWith('/')
        ? pathToFileURL(resolve(dirname(configPath), entry.entry)).href : entry.entry,
    }))
  }
  const modules = moduleLocations(config.modules)
  const additionalModules = moduleLocations(config.additionalModules)
  let moduleHost: NativeDeploymentHost | undefined;
  if (config.capabilities !== undefined) {
    const target = pathToFileURL(resolve(dirname(configPath), config.capabilities.entry)).href;
    const deployment: CapabilityEntry = await import(target);
    if (typeof deployment.createModuleHost !== 'function')
      throw new KernelError('INVALID', 'Native capability entry must export createModuleHost');
    moduleHost = await deployment.createModuleHost(config.id);
  }

  let io: ActionIoBinding | undefined;
  if (config.io !== undefined) {
    const target = pathToFileURL(resolve(dirname(configPath), config.io.entry)).href;
    const deployment: { readonly bindIo: ActionIoBinding } = await import(target);
    if (typeof deployment.bindIo !== 'function')
      throw new KernelError('INVALID', 'Native I/O entry must export bindIo');
    io = deployment.bindIo;
  }
  const mountDirectories =
    config.mountDirectories === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(config.mountDirectories).map(([capability, directory]) => [
            capability,
            resolve(dirname(configPath), directory),
          ]),
        )
  const runtime = await openNativeDeployment({ seedFilter: config.seedFilter, runtime: { id: config.id, directory: resolve(dirname(configPath), config.directory),
    baseDirectory: config.baseDirectory === undefined ? undefined : resolve(dirname(configPath), config.baseDirectory),
    credentialTtlMs: config.credentialTtlMs, firstAdmin: config.firstAdmin, installerCredential: config.installerCredential, mountDirectories }, modules, additionalModules, host: moduleHost, io, persistentLogs: config.persistentLogs })
  const binding = createTwpHttpServer({ instance: runtime.instance, routes: runtime.httpRoutes, allowedOrigins: config.allowedOrigins, credentialTtlMs: config.credentialTtlMs })
  try {
    await new Promise<void>((done, reject) => { binding.server.once('error', reject); binding.server.listen(port, host, () => { binding.server.off('error', reject); done() }) })
  } catch (error) { await binding.close(); await runtime.close(); throw error }
  let stopping: Promise<void> | undefined
  function stop(): Promise<void> { return stopping ??= (async () => { try { await binding.close() } finally { await runtime.close() } })() }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    stop().catch(error => { console.error(error); process.exitCode = 1 })
  })
  console.info('Treenix native server listening:', binding.server.address())
}

main().catch(error => { console.error(error); process.exitCode = 1 })
