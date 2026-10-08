import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import type { Frame, LaneChange, NodeCopy, NodeId, Position, Principal, SubId } from '#kernel/types'
import { applyDelta } from '#kernel/update-ops'

export interface LaneList { readonly gen: number; readonly ids: readonly NodeId[] }
const identity = (copy: NodeCopy) => 'node' in copy ? copy.node.$id : copy.id
const path = (copy: NodeCopy) => 'node' in copy ? copy.node.$path : copy.path

export function createLaneCache() {
  const copies = new Map<NodeId, NodeCopy>(), paths = new Map<string, NodeId>(), lists = new Map<SubId, LaneList>()
  const watermarks = new Map<string, Position>()
  let principal: Principal | undefined
  function clear(): void { copies.clear(); paths.clear(); lists.clear(); watermarks.clear() }
  function apply(frame: Frame): void {
    if (frame.t === 'welcome') {
      if (principal !== frame.principal) clear()
      principal = frame.principal
      return
    }
    const changes = new Map<NodeId, NodeCopy | null>(), membership = new Map<SubId, LaneList>()
    function put(copy: NodeCopy): void { changes.set(identity(copy), copy) }
    function diff(sub: SubId, gen: number, items: Extract<LaneChange, { op: 'list' }>['diff']): void {
      const current = membership.get(sub) ?? lists.get(sub)
      if (current === undefined || current.gen !== gen) return
      const ids = new Set(current.ids)
      for (const item of items) 'add' in item ? ids.add(item.add) : ids.delete(item.remove)
      membership.set(sub, { gen, ids: [...ids] })
    }
    switch (frame.t) {
      case 'snap': {
        const previous = lists.get(frame.sub)
        if (previous !== undefined && frame.gen < previous.gen) return
        membership.set(frame.sub, { gen: frame.gen, ids: [...frame.list] })
        for (const copy of frame.copies) put(copy)
        for (const pos of frame.at) if (!watermarks.has(pos.instance)) watermarks.set(pos.instance, pos)
        break
      }
      case 'result': {
        if (lists.get(frame.sub)?.gen !== frame.gen) return
        diff(frame.sub, frame.gen, frame.diff)
        for (const copy of frame.copies) put(copy)
        break
      }
      case 'pos': {
        const previous = watermarks.get(frame.pos.instance)
        if (frame.coverage === true) {
          if (previous === undefined || comparePositions(frame.pos, previous) !== 0)
            throw new KernelError('INVALID', 'Coverage frame differs from its delivered watermark')
        } else if (previous !== undefined && comparePositions(frame.pos, previous) <= 0)
          throw new KernelError('INVALID', 'Lane positions must increase')
        for (const change of frame.changes) {
          switch (change.op) {
            case 'put': put(change.copy); break
            case 'del': changes.set(change.id, null); break
            case 'list': diff(change.sub, change.gen, change.diff); break
            case 'patch': {
              const previous = changes.has(change.id) ? changes.get(change.id) : copies.get(change.id)
              if (previous === undefined || previous === null || !('node' in previous) || previous.ver !== change.base)
                throw new KernelError('CONFLICT', 'Lane patch base does not match the cached copy')
              put({ node: applyDelta(previous.node, change.delta), ver: change.ver, bits: change.bits })
              break
            }
          }
        }
        if (frame.coverage !== true) watermarks.set(frame.pos.instance, frame.pos)
        break
      }
      case 'reset': {
        const previous = lists.get(frame.sub)
        if (previous === undefined || frame.gen > previous.gen) lists.set(frame.sub, { gen: frame.gen, ids: [] })
        return
      }
      case 'end': lists.delete(frame.sub); return
      default: return
    }
    for (const id of changes.keys()) {
      const previous = copies.get(id)
      if (previous !== undefined && paths.get(path(previous)) === id) paths.delete(path(previous))
    }
    for (const [id, copy] of changes) {
      if (copy === null) copies.delete(id)
      else { copies.set(id, copy); paths.set(path(copy), id) }
    }
    for (const [sub, list] of membership) lists.set(sub, list)
  }
  return { apply, clear, copy: (id: NodeId) => copies.get(id), at: (path: string) => {
    const id = paths.get(path)
    return id === undefined ? undefined : copies.get(id)
  }, list: (sub: SubId) => lists.get(sub), watermark: (instance: string) => watermarks.get(instance),
  claims: () => [...copies].map(([id, copy]) => ({ id, ver: copy.ver })), forget: (sub: SubId) => lists.delete(sub) }
}

export type LaneCache = ReturnType<typeof createLaneCache>
