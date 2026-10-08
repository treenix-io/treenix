import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeJsonParse } from '#core/json'
import { KernelError } from '#errors'
import type { AdminInput } from '#kernel/auth-module'
import { collectModule } from '#kernel/manifest'
import { openNativeRuntime } from '#kernel/runtime'
import type { Credential } from '#kernel/types'
import { createTwpHttpServer } from '#server/http-twp'
import { isRecord } from '#util/is-record'

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

async function main(): Promise<void> {
  const argument = process.argv[2]
  if (argument === undefined) throw new KernelError('INVALID', 'Use npm run dev:kernel -- path/to/kernel-config.json')
  const configPath = resolve(argument), config = safeJsonParse(await readFile(configPath, 'utf8'))
  if (!isRecord(config) || typeof config.id !== 'string' || typeof config.directory !== 'string' || typeof config.credentialTtlMs !== 'number'
    || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.every((value: unknown): value is string => typeof value === 'string')
    || config.firstAdmin !== undefined && !adminInput(config.firstAdmin)
    || config.installerCredential !== undefined && !credentialInput(config.installerCredential)
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
  const runtime = await openNativeRuntime({ id: config.id, directory: resolve(dirname(configPath), config.directory),
    credentialTtlMs: config.credentialTtlMs, firstAdmin: config.firstAdmin, installerCredential: config.installerCredential, modules })
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
