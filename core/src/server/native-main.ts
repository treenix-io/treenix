import type { ActionIoBinding, AdminInput } from '#kernel/types'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeJsonParse } from '#core/json'
import { KernelError } from '#errors'
import { collectModule } from '#kernel/manifest'
import type { FsDirectoryBindings } from '#kernel/mount-fs-provider'
import { openNativeRuntime } from '#kernel/runtime'
import type { Credential } from '#kernel/types'
import { createTwpHttpServer } from '#server/http-twp'
import { isRecord } from '#util/is-record'

interface IoEntry { readonly entry: string }
/** Decode the deployment entry before acquiring persistent runtime resources. */
function ioEntry(value: unknown): value is IoEntry {
  return isRecord(value) && typeof value.entry === 'string' && value.entry.length > 0
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
  const argument = process.argv[2]
  if (argument === undefined) throw new KernelError('INVALID', 'Use npm run dev:kernel -- path/to/kernel-config.json')
  const configPath = resolve(argument), config = safeJsonParse(await readFile(configPath, 'utf8'))
  if (!isRecord(config) || typeof config.id !== 'string' || typeof config.directory !== 'string' || typeof config.credentialTtlMs !== 'number'
    || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.every((value: unknown): value is string => typeof value === 'string')
    || config.firstAdmin !== undefined && !adminInput(config.firstAdmin)
    || config.installerCredential !== undefined && !credentialInput(config.installerCredential)
    || config.io !== undefined && !ioEntry(config.io)
    || config.mountDirectories !== undefined && !directoryBindings(config.mountDirectories)
    || config.modules !== undefined && (!Array.isArray(config.modules) || !config.modules.every(moduleEntry)))
    throw new KernelError('INVALID', 'Malformed native server configuration')
  const port = config.port ?? 4882, host = config.host ?? '127.0.0.1'
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 0 || port > 65535 || typeof host !== 'string')
    throw new KernelError('INVALID', 'Malformed native listen address')
  const modules = []
  for (const entry of config.modules ?? []) {
    const target = entry.entry.startsWith('.') || entry.entry.startsWith('/')
      ? pathToFileURL(resolve(dirname(configPath), entry.entry)).href : entry.entry
    modules.push(await collectModule(entry.id, () => import(target), target))
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
  const runtime = await openNativeRuntime({ id: config.id, directory: resolve(dirname(configPath), config.directory),
    credentialTtlMs: config.credentialTtlMs, firstAdmin: config.firstAdmin, installerCredential: config.installerCredential, modules, mountDirectories, io })
  const binding = createTwpHttpServer({ instance: runtime.instance, allowedOrigins: config.allowedOrigins, credentialTtlMs: config.credentialTtlMs })
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
