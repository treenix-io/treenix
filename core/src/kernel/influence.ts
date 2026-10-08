import { isChildPath } from '#core/path'
import { KernelError } from '#errors'
import type { NodeChange } from '#kernel/changeset'
import type { ExprWork } from '#kernel/eval'
import { createSiftTest } from '#kernel/expr'
import { comparePositions } from '#kernel/position'
import { mapNodeForSift } from '#kernel/store/keys'
import { DEFAULT_LIMITS, type DomainId, type Limits, type Node, type Position, type Selector, type StoredNode } from '#kernel/types'
import { freeze } from '#util/freeze'

export interface InfluenceWrite {
  readonly domain: DomainId
  readonly path: string
  readonly pos: Position
  readonly before: StoredNode | null | 'unknown'
  readonly after: StoredNode | null
}
export interface InfluenceContext {
  readonly project: (node: StoredNode, selector: Selector) => Node | null
  readonly work: ExprWork
  readonly limits?: Limits
}

export function createInfluenceTest(selector: Selector, { project, work, limits = DEFAULT_LIMITS }: InfluenceContext) {
  const test = 'children' in selector && selector.where !== undefined ? createSiftTest(selector.where, limits) : undefined
  return (write: InfluenceWrite): boolean => {
    const inRange = 'node' in selector ? write.path === selector.node
      : 'children' in selector ? isChildPath(selector.children, write.path, true)
      : write.path === selector.history || isChildPath(selector.history, write.path, false)
    if (!inRange) return false
    if (write.before === 'unknown') return true
    for (const image of [write.before, write.after]) {
      if (image === null) continue
      const visible = project(image, selector)
      if (visible !== null && (test === undefined || test(mapNodeForSift(visible), work))) return true
    }
    return false
  }
}

export interface InfluenceOptions {
  readonly position: Position
  readonly domains: readonly DomainId[]
  readonly maxWrites?: number
  readonly maxBytes?: number
}
export function createInfluenceIndex(options: InfluenceOptions) {
  const rows = new Map<InfluenceWrite, number>()
  const floors = new Map(options.domains.map(domain => [domain, options.position]))
  const maxWrites = options.maxWrites ?? DEFAULT_LIMITS.readNodes, maxBytes = options.maxBytes ?? DEFAULT_LIMITS.readBytes
  let position = options.position, bytes = 0
  const image = (node: StoredNode | null) => node === null || Object.isFrozen(node) ? node : freeze(structuredClone(node))
  function advance(pos: Position): void {
    if (comparePositions(pos, position) <= 0) throw new KernelError('INVALID', 'Influence positions must increase')
    if (pos.epoch !== position.epoch || pos.seq !== position.seq + 1) {
      const floor = { ...pos, seq: Math.max(0, pos.seq - 1) }
      for (const [domain, prior] of floors) if (comparePositions(floor, prior) > 0) floors.set(domain, floor)
    }
    position = Object.freeze({ ...pos })
  }
  function put(write: InfluenceWrite): void {
    const size = Buffer.byteLength(JSON.stringify(write))
    rows.set(Object.freeze(write), size); bytes += size
    while (rows.size > maxWrites || bytes > maxBytes) {
      const [oldest, size] = rows.entries().next().value!
      rows.delete(oldest); bytes -= size
      if (comparePositions(oldest.pos, floors.get(oldest.domain)!) > 0) floors.set(oldest.domain, oldest.pos)
    }
  }
  return {
    get position(): Position { return position },
    get size(): number { return rows.size },
    get bytes(): number { return bytes },
    advance,
    record(domain: DomainId, pos: Position, changes: readonly NodeChange[]): void {
      if (!floors.has(domain)) throw new KernelError('INVALID', 'Unknown influence domain')
      advance(pos)
      for (const change of changes) {
        const before = image(change.before), after = image(change.after)
        if (before !== null) put({ domain, pos: position, path: before.$path, before,
          after: after?.$path === before.$path ? after : null })
        if (after !== null && before?.$path !== after.$path) {
          put({ domain, pos: position, path: after.$path, before: null, after })
        }
      }
    },
    reset(domain: DomainId, pos: Position): void {
      if (!floors.has(domain)) throw new KernelError('INVALID', 'Unknown influence domain')
      advance(pos); floors.set(domain, position)
      for (const [write, size] of rows) if (write.domain === domain) { rows.delete(write); bytes -= size }
    },
    check(selector: Selector, cursors: readonly Position[], before: Position, domains: readonly DomainId[], context: InfluenceContext): void {
      let from: Position | undefined
      for (const cursor of cursors) if (cursor.instance === before.instance
        && (from === undefined || comparePositions(cursor, from) < 0)) from = cursor
      if (from === undefined || comparePositions(from, before) >= 0 || comparePositions(from, position) > 0) throw new KernelError('CONFLICT', 'The selector interval is not known')
      for (const domain of domains) {
        const floor = floors.get(domain)
        if (floor === undefined) throw new KernelError('INVALID', 'Unknown influence domain')
        if (comparePositions(from, floor) < 0) throw new KernelError('CONFLICT', 'The selector interval was truncated')
      }
      const selected = new Set(domains), affects = createInfluenceTest(selector, context)
      for (const write of rows.keys()) if (selected.has(write.domain) && comparePositions(write.pos, from) > 0
        && comparePositions(write.pos, before) < 0 && affects(write)) throw new KernelError('CONFLICT', 'A write affected the selector')
    },
  }
}
export type InfluenceIndex = ReturnType<typeof createInfluenceIndex>
