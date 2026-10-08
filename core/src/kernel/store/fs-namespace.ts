import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { FieldDeltas, NodeTransition, Path, StoreCommit, StoredNode } from '#kernel/types'
import { isRecord } from '#util/is-record'

/** Whole-image delta values cross the Fs format boundary as unknown JSON. */
function assertImage(value: unknown): asserts value is StoredNode {
  if (!isRecord(value) || typeof value.$path !== 'string' || typeof value.$id !== 'string'
    || typeof value.$type !== 'string' || !isRecord(value.$pos)
    || typeof value.$pos.instance !== 'string' || typeof value.$pos.epoch !== 'number'
    || !Number.isSafeInteger(value.$pos.epoch) || value.$pos.epoch < 0
    || typeof value.$pos.seq !== 'number' || !Number.isSafeInteger(value.$pos.seq) || value.$pos.seq < 0) {
    throw new KernelError('INVALID', 'Filesystem whole-image delta is not a stored node')
  }
}

/** Keep the disk journal local while the one owned storage shadow uses logical addresses. */
export function createFsNamespace(base: Path) {
  try { assertSafePath(base) } catch (error) {
    console.error(error)
    throw new KernelError('INVALID', 'Invalid filesystem logical base')
  }

  /** Enforce an exact path-segment boundary before a logical write reaches disk. */
  function localPath(path: Path): Path {
    if (base === '/') return path
    if (path === base) return '/'
    if (!path.startsWith(`${base}/`)) throw new KernelError('INVALID', 'Filesystem address is outside its logical base')
    return path.slice(base.length)
  }

  /** The physical root represents the declaring address, including for wildcard mounts. */
  function logicalPath(path: Path): Path {
    return base === '/' ? path : path === '/' ? base : `${base}${path}`
  }

  /** Issued identities and user fields retain their meaning across a namespace mapping. */
  function node(image: StoredNode, path: (value: Path) => Path): StoredNode {
    return { ...image, $path: path(image.$path),
      $id: image.$id.startsWith('p:') ? `p:${path(image.$id.slice(2))}` : image.$id }
  }

  /** Rewrite only structural delta values, never paths embedded in user payload. */
  function deltas(fields: FieldDeltas, path: (value: Path) => Path): FieldDeltas {
    const mapped = { ...fields }
    for (const key of ['', '$path', '$id']) {
      const change = fields[key]
      if (change === undefined) continue
      const value = (input: unknown): unknown => {
        if (key === '') { assertImage(input); return node(input, path) }
        if (typeof input !== 'string') throw new KernelError('INVALID', 'Filesystem structural delta is not a string')
        return key === '$path' ? path(input) : input.startsWith('p:') ? `p:${path(input.slice(2))}` : input
      }
      mapped[key] = {
        ...(Object.hasOwn(change, 'from') ? { from: value(change.from) } : {}),
        ...(Object.hasOwn(change, 'to') ? { to: value(change.to) } : {}),
      }
    }
    return mapped
  }

  /** Full and compact transitions must reconstruct the same logical before and after images. */
  function transition(change: NodeTransition, path: (value: Path) => Path): NodeTransition {
    switch (change.t) {
      case 'create': return { ...change, after: node(change.after, path) }
      case 'delete': return { ...change, before: node(change.before, path) }
      case 'update': return { ...change, delta: deltas(change.delta, path),
        ...(change.after === undefined ? {} : { after: node(change.after, path) }) }
      case 'reconcile': return { ...change,
        after: change.after === null ? null : node(change.after, path),
        ...(change.before === undefined ? {} : { before: change.before === null ? null : node(change.before, path) }) }
    }
  }

  /** Decisions describe the original logical request and outcome, so their data is preserved. */
  function commit(input: StoreCommit, path: (value: Path) => Path): StoreCommit {
    if (base === '/') return input
    return { ...input,
      writes: input.writes.map(write => ({ path: path(write.path), node: write.node === null ? null : node(write.node, path) })),
      record: { ...input.record, entries: input.record.entries.map(entry => ({ ...entry,
        id: entry.id.startsWith('p:') ? `p:${path(entry.id.slice(2))}` : entry.id,
        path: path(entry.path), ...(entry.from === undefined ? {} : { from: path(entry.from) }),
        change: transition(entry.change, path),
      })) },
    }
  }

  return {
    local: (input: StoreCommit) => commit(input, localPath),
    logical: (input: StoreCommit) => commit(input, logicalPath),
    logicalNode: (image: StoredNode) => base === '/' ? image : node(image, logicalPath),
  }
}
