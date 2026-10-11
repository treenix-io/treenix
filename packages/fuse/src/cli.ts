#!/usr/bin/env tsx
// CLI: treenix-mount <mountpoint> [--url=http://localhost:3211] [--token=...] [--debug]
import { createFuseMount } from '#index'
import { openTwpHttp } from '@treenx/core/client/http-twp'
import { createTwpClient } from '@treenx/core/client/twp'
import { mkdir } from 'node:fs/promises'

const args = process.argv.slice(2)
const flags = Object.fromEntries(args.filter(arg => arg.startsWith('--')).map(arg => {
  const separator = arg.indexOf('=')
  return separator === -1 ? [arg.slice(2), 'true'] : [arg.slice(2, separator), arg.slice(separator + 1)]
}))
const mountpoint = args.find(arg => !arg.startsWith('--'))
if (mountpoint === undefined) throw new Error('Usage: treenix-mount <mountpoint> [--url=...] [--token=...] [--debug]')

const url = flags.url ?? 'http://localhost:3211'
const credential = flags.token === undefined ? undefined : { token: flags.token }
await mkdir(mountpoint, { recursive: true })
const connection = await openTwpHttp({ url, credential })
const client = createTwpClient(connection, { credential, close: connection.close })
const mount = createFuseMount({ client, mountpoint, debug: 'debug' in flags })

/** Finish native unmount before relinquishing the request-owned transport. */
async function shutdown(): Promise<void> {
  try { await mount.close() } catch (error) { console.error(error); process.exitCode = 1 }
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
try {
  await client.ready
  await mount.mount()
  console.log(`[fuse] native @ ${url} → ${mountpoint}`)
} catch (error) {
  await shutdown()
  throw error
}
