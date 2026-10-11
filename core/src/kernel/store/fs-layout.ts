import { createHash } from 'node:crypto'
import { lstat, open, opendir, readFile, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { safeJsonParse } from '#core/json'
import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { Budget, Path, ScanRange, Position, StoredNode, StoredWrite, StorageFaultChange } from '#kernel/types'
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
  for (const file of [join(root, path.slice(1), '$'), join(root, path.slice(1), '$.json')]) {
    await assertPathSafe(root, file)
    try { if ((await lstat(file)).isSymbolicLink()) throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed') } catch (error) { if (!missing(error)) throw error }
  }
  await legacyEntry(root, path === '/' ? `${root}/` : join(root, path.slice(1)))
}

/** An optional legacy sibling may exceed the filename limit while its genuine directory address fits. */
async function legacyEntry(root: string, base: string): Promise<Stats | undefined> {
  await assertPathSafe(root, base)
  try {
    const file = `${base}.json`
    await assertPathSafe(root, file)
    const entry = await lstat(file)
    if (entry.isSymbolicLink())
      throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed')
    return entry
  } catch (error) {
    if (
      missing(error) ||
      (error instanceof Error && 'code' in error && error.code === 'ENAMETOOLONG')
    )
      return undefined
    throw error
  }
}

/** Remove only a present optional leaf; directory node bodies use their ordinary path checks. */
async function removeLegacyFile(root: string, base: string): Promise<void> {
  const entry = await legacyEntry(root, base)
  if (entry === undefined || entry.isDirectory()) return
  await unlink(`${base}.json`)
  await syncDirectory(dirname(base))
}

/** Read physical bodies in one bounded logical subtree, validating the filesystem boundary. */
export async function scanFsNodes(root: string, pos: Position, range: ScanRange, budget: Budget, quarantine = false) {
  const subtree = 'node' in range ? range.node : 'children' in range ? range.children : range.subtree
  fsAddress(subtree)
  const depth = 'node' in range ? 0 : 'children' in range ? 1 : Number.MAX_SAFE_INTEGER
  const nodes = new Map<string, StoredNode>()
  const hashes = new Map<Path, string>()
  const faults: StorageFaultChange[] = []
  const cost = { nodes: 0, bytes: 0, exprWork: 0 }
  function check(): void {
    if (Date.now() > budget.deadline || cost.nodes > budget.nodes || cost.bytes > budget.bytes || cost.exprWork > budget.exprWork)
      throw new KernelError('BUDGET', 'Filesystem physical read budget exceeded')
  }
  async function body(file: string, path: string): Promise<void> {
    cost.nodes++; check()
    await assertPathSafe(root, file)
    const handle = await open(file, 'r')
    const chunks: Buffer[] = []
    try {
      while (true) {
        check()
        const buffer = Buffer.alloc(Math.min(64 * 1024, budget.bytes - cost.bytes + 1))
        const { bytesRead } = await handle.read(buffer)
        cost.bytes += bytesRead; cost.exprWork++; check()
        if (bytesRead === 0) break
        chunks.push(buffer.subarray(0, bytesRead))
      }
    } finally { await handle.close() }
    const data = Buffer.concat(chunks).toString('utf8')
    hashes.set(path, createHash('sha256').update(data).digest('hex'))
    try {
      const raw: unknown = safeJsonParse(data)
      if (!isRecord(raw) || typeof raw.$type !== 'string' || raw.$type.length === 0 || raw.$id !== undefined && (typeof raw.$id !== 'string' || raw.$id.length === 0)
        || '$rev' in raw || '$pos' in raw || '$path' in raw || nodes.has(path)) throw new KernelError('INVALID', 'Invalid filesystem node body')
      assertStoredJson(raw)
      nodes.set(path, { ...raw, $id: raw.$id ?? `p:${path}`, $type: raw.$type, $path: path, $pos: pos })
    } catch (error) {
      if (!quarantine || !(error instanceof SyntaxError || error instanceof KernelError && error.code === 'INVALID')) throw error
      faults.push({ path, fault: { code: 'INVALID', invalid: 'chain' } })
    }
  }
  async function walk(directory: string, level = 0): Promise<void> {
    cost.exprWork++; check()
    await assertPathSafe(root, directory)
    for await (const entry of await opendir(directory, { bufferSize: 1 })) {
      cost.exprWork++; check()
      if (directory === root && ['.treenix', '.git'].includes(entry.name)) continue
      const file = join(directory, entry.name)
      await assertPathSafe(root, file)
      if (entry.isSymbolicLink()) throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed')
      if (entry.isDirectory()) {
        if ('children' in range && level === 0) await directoryBody(file, `/${relative(root, file)}`)
        else if (level < depth) await walk(file, level + 1)
        continue
      }
      if (entry.name !== '$' && !entry.name.endsWith('.json')) continue
      const path = entry.name === '$' || entry.name === '$.json' ? `/${relative(root, directory)}` : `/${relative(root, file).slice(0, -5)}`
      fsAddress(path)
      if (path === subtree && 'children' in range || path !== subtree && 'node' in range) continue
      await body(file, path)
    }
  }
  /** An exact node body does not require enumerating the directory's children. */
  async function directoryBody(directory: string, path: Path): Promise<void> {
    for (const name of ['$', '$.json']) {
      cost.exprWork++; check()
      const file = join(directory, name)
      await assertPathSafe(root, file)
      let entry: Stats | undefined
      try { entry = await lstat(file) } catch (error) { if (!missing(error)) throw error }
      if (entry?.isSymbolicLink()) throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed')
      if (entry?.isFile()) await body(file, path)
    }
  }
  const base = join(root, subtree.slice(1))
  while (true) {
    cost.exprWork++; check()
    await assertPathSafe(root, base)
    let entry: Stats | undefined
    try {
      entry = await lstat(base)
    } catch (error) { if (!missing(error)) throw error }
    try {
      if (entry?.isSymbolicLink()) throw new KernelError('FORBIDDEN', 'Filesystem node symlinks are not allowed')
      if (entry?.isDirectory()) {
        if ('node' in range) await directoryBody(base, subtree)
        else await walk(base)
      }
      if (!('children' in range) && subtree !== '/' && (await legacyEntry(root, base))?.isFile()) await body(`${base}.json`, subtree)
      return { nodes: [...nodes.values()], hashes, faults, cost }
    } catch (error) {
      if (!missing(error)) throw error
      // A disappearing descendant invalidates the whole result; retries retain every consumed unit.
      nodes.clear(); hashes.clear(); faults.length = 0
    }
  }
}

/** Import accepted startup files before a journal exists. */
export async function readFsNodes(root: string, pos: Position): Promise<StoredNode[]> {
  const result = await scanFsNodes(root, pos, { subtree: '/' }, { nodes: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER,
    exprWork: Number.MAX_SAFE_INTEGER, deadline: Date.now() + 10_000 })
  return result.nodes
}

async function removeFile(root: string, file: string): Promise<void> {
  await assertPathSafe(root, file)
  try {
    if ((await lstat(file)).isDirectory()) return
    await unlink(file); await syncDirectory(dirname(file))
  } catch (error) { if (!missing(error)) throw error }
}

export async function writeFsNode(root: string, write: StoredWrite): Promise<string | undefined> {
  const base = join(root, write.path.slice(1)), directoryFile = join(base, '$')
  fsAddress(write.path)
  if (write.node === null) {
    await removeFile(root, directoryFile)
    await removeFile(root, join(base, '$.json'))
    if (write.path !== '/') await removeLegacyFile(root, base)
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
    if ((await legacyEntry(root, parent))?.isFile()) {
      const data = await readFile(parentLeaf)
      await durableWrite(root, join(parent, '$'), data)
      await removeLegacyFile(root, parent)
    }
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
  const content = `${JSON.stringify(data, null, 2)}\n`
  await durableWrite(root, directoryFile, content)
  await removeFile(root, legacyBody)
  return content
}
