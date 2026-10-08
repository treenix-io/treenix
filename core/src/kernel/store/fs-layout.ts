import { lstat, readdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { safeJsonParse } from '#core/json'
import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { Position, StoredNode, StoredWrite } from '#kernel/types'
import { assertPathSafe } from '#util/path-safety'
import { isRecord } from '#util/is-record'
import { durableDirectory, durableWrite, missing, syncDirectory } from './fs-io'
import { assertStoredJson } from './fs-journal'

export function fsAddress(path: string): void {
  try { assertSafePath(path) } catch (error) {
    console.error(error)
    throw new KernelError('INVALID', 'Invalid filesystem node address')
  }
  if (path === '/') return
  const parts = path.split('/').slice(1)
  if (['.treenix', '.git'].includes(parts[0]) || parts.includes('$')) throw new KernelError('INVALID', 'Reserved filesystem node address')
}

export async function fsWriteSafe(root: string, path: string): Promise<void> {
  fsAddress(path)
  let file = root, blockedByLeaf = false
  for (const part of path === '/' ? [] : path.slice(1).split('/')) {
    file = join(file, part)
    await assertPathSafe(root, file)
    try {
      const entry = await lstat(file)
      if (entry.isSymbolicLink()) throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed')
      if (!entry.isDirectory() && !file.endsWith('.json')) throw new KernelError('INVALID', 'Filesystem node address is occupied by a raw file')
      if (!entry.isDirectory()) { blockedByLeaf = true; break }
    } catch (error) { if (!missing(error)) throw error }
  }
  if (blockedByLeaf) return
  for (const file of [join(root, path.slice(1), '$'), join(root, path.slice(1), '$.json'), join(root, `${path.slice(1)}.json`)]) {
    await assertPathSafe(root, file)
    try { if ((await lstat(file)).isSymbolicLink()) throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed') } catch (error) { if (!missing(error)) throw error }
  }
}

export async function readFsNodes(root: string, pos: Position): Promise<StoredNode[]> {
  const nodes = new Map<string, StoredNode>()
  async function walk(directory: string): Promise<void> {
    await assertPathSafe(root, directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && ['.treenix', '.git'].includes(entry.name)) continue
      const file = join(directory, entry.name)
      await assertPathSafe(root, file)
      if (entry.isSymbolicLink()) throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed')
      if (entry.isDirectory()) { await walk(file); continue }
      if (entry.name !== '$' && !entry.name.endsWith('.json')) continue
      const path = entry.name === '$' || entry.name === '$.json' ? `/${relative(root, directory)}` : `/${relative(root, file).slice(0, -5)}`
      fsAddress(path)
      const raw: unknown = safeJsonParse(await readFile(file, 'utf8'))
      if (!isRecord(raw) || typeof raw.$type !== 'string' || raw.$id !== undefined && typeof raw.$id !== 'string'
        || '$rev' in raw || '$pos' in raw || '$path' in raw || nodes.has(path)) throw new KernelError('INVALID', 'Invalid filesystem node body')
      assertStoredJson(raw)
      nodes.set(path, { ...raw, $id: raw.$id ?? `p:${path}`, $type: raw.$type, $path: path, $pos: pos })
    }
  }
  await walk(root)
  return [...nodes.values()]
}

async function removeFile(root: string, file: string): Promise<void> {
  await assertPathSafe(root, file)
  try {
    if ((await lstat(file)).isDirectory()) return
    await unlink(file); await syncDirectory(dirname(file))
  } catch (error) { if (!missing(error)) throw error }
}

export async function writeFsNode(root: string, write: StoredWrite): Promise<void> {
  const base = join(root, write.path.slice(1)), directoryFile = join(base, '$'), leaf = `${base}.json`
  fsAddress(write.path)
  if (write.node === null) {
    await removeFile(root, directoryFile)
    await removeFile(root, join(base, '$.json'))
    if (write.path !== '/') await removeFile(root, leaf)
    return
  }
  const parts = write.path === '/' ? [] : write.path.slice(1).split('/')
  for (let i = 1; i <= parts.length; i++) {
    const parent = join(root, ...parts.slice(0, i)), parentLeaf = `${parent}.json`
    await assertPathSafe(root, parent)
    try {
      const entry = await lstat(parent)
      if (!entry.isDirectory()) {
        if (!parent.endsWith('.json')) throw new KernelError('INVALID', 'Filesystem directory is occupied')
        const data = await readFile(parent)
        await durableWrite(root, join(parent.endsWith('/$.json') ? dirname(parent) : parent.slice(0, -5), '$'), data)
        await removeFile(root, parent)
      }
    } catch (error) { if (!missing(error)) throw error }
    await assertPathSafe(root, parentLeaf)
    try {
      if ((await lstat(parentLeaf)).isFile()) {
        const data = await readFile(parentLeaf)
        await durableWrite(root, join(parent, '$'), data)
        await removeFile(root, parentLeaf)
      }
    } catch (error) { if (!missing(error)) throw error }
    await durableDirectory(parent)
    const legacy = join(parent, '$.json')
    await assertPathSafe(root, legacy)
    try {
      if ((await lstat(legacy)).isFile()) {
        await durableWrite(root, join(parent, '$'), await readFile(legacy))
        await removeFile(root, legacy)
      }
    } catch (error) { if (!missing(error)) throw error }
  }
  const legacyBody = join(base, '$.json')
  await assertPathSafe(root, base)
  const { $path, $pos, $rev, $id, ...body } = write.node
  if ($id.startsWith('p:') && $id !== `p:${write.path}`) throw new KernelError('INVALID', 'Path identity differs from the filesystem address')
  const data = $id.startsWith('p:') ? body : { ...body, $id }
  await durableWrite(root, directoryFile, `${JSON.stringify(data, null, 2)}\n`)
  await removeFile(root, legacyBody)
}
