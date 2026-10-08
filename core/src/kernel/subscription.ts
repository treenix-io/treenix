import { assertSafePath } from '#core/path'
import type { NodeId, Path } from '#kernel/types'

export interface NodeSubscription {
  readonly id: string
  readonly path: Path
  readonly controller: AbortController
  gen: number
  ready: boolean
  initial: boolean
  member?: NodeId
  dirty: number
  stamp: number
  forcePut: boolean
}

export function createSubscriptions() {
  const entries = new Map<string, NodeSubscription>()
  const routes = new Map<Path, Set<NodeSubscription>>()
  function ancestors(path: Path): Path[] {
    const result = [path]
    while (path !== '/') {
      path = path.slice(0, path.lastIndexOf('/')) || '/'
      result.push(path)
    }
    return result
  }
  function remove(sub: NodeSubscription): void {
    entries.delete(sub.id)
    for (const path of ancestors(sub.path)) {
      const route = routes.get(path)!
      route.delete(sub)
      if (route.size === 0) routes.delete(path)
    }
  }
  function dirty(sub: NodeSubscription, force: boolean): void {
    sub.dirty = Math.min(2, sub.dirty + 1)
    sub.stamp++
    sub.forcePut ||= force
  }
  return {
    entries,
    add(id: string, path: Path, gen: number): NodeSubscription {
      assertSafePath(path)
      const sub: NodeSubscription = { id, path, gen, controller: new AbortController(), ready: false,
        initial: true, dirty: 0, stamp: 0, forcePut: false }
      entries.set(id, sub)
      for (const dependency of ancestors(path)) {
        let route = routes.get(dependency)
        if (route === undefined) { route = new Set(); routes.set(dependency, route) }
        route.add(sub)
      }
      return sub
    },
    remove,
    current: (sub: NodeSubscription) => entries.get(sub.id) === sub,
    changed(path: Path, force: boolean): void {
      const affected = routes.get(path)
      if (affected !== undefined) for (const sub of affected) dirty(sub, force || sub.path !== path)
    },
    dirty,
  }
}
