import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertPathSafe } from '#util/path-safety'

export const missing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function durableDirectory(directory: string): Promise<void> {
  try {
    const current = await lstat(directory)
    if (!current.isDirectory()) throw new Error('Persistent directory is not a directory')
    return
  } catch (error) { if (!missing(error)) throw error }
  const parent = dirname(directory)
  await durableDirectory(parent)
  await mkdir(directory, { mode: 0o700 })
  await syncDirectory(parent)
}

export async function durableWrite(root: string, file: string, data: string | Buffer): Promise<void> {
  await assertPathSafe(root, file)
  await durableDirectory(dirname(file))
  await assertPathSafe(root, file)
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
  await rename(temporary, file)
  await syncDirectory(dirname(file))
}
