// Virtual read-only Tree over React Fiber.
// Walks the live Fiber tree on each query — no state, no tracking.
// Registered as t.mount.react — isomorphic mount, same as server-side mounts.

import type { NodeData } from '@treenx/core';
import { register } from '@treenx/core';
import type { Tree } from '@treenx/core/tree';

const PREFIX = '/local/react'

interface FiberNode {
  $path: string
  $type: string
  sourcePath?: string
  children?: FiberNode[]
}

// Detect <Render> by name + props shape (resilient to HMR wrappers)
function isRenderFiber(f: any): boolean {
  if (!f.memoizedProps?.value?.$type) return false
  const name = f.type?.name || f.type?.displayName || ''
  return name === 'Render'
}

function getRootFiber() {
  const el = document.getElementById('root')
  if (!el) return null

  // React 19 createRoot: __reactContainer$ on the container element
  const containerKey = Object.keys(el).find(k => k.startsWith('__reactContainer$'))
  if (containerKey) return (el as any)[containerKey]

  // React 18 fallback: __reactFiber$ on first child
  const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
  return fiberKey ? (el as any)[fiberKey] : null
}

function walk(fiber: any, parentPath: string, maxDepth: number, depth = 0): FiberNode[] {
  if (depth >= maxDepth) return []

  const result: FiberNode[] = []
  let f = fiber?.child
  let i = 0

  while (f) {
    if (isRenderFiber(f)) {
      const v = f.memoizedProps.value
      const path = `${parentPath}/${i}`
      result.push({
        $path: path,
        $type: v.$type,
        sourcePath: v.$path,
        children: depth + 1 < maxDepth ? walk(f, path, maxDepth, depth + 1) : undefined,
      })
      i++
    } else {
      result.push(...walk(f, parentPath, maxDepth, depth))
    }
    f = f.sibling
  }

  return result
}

function scan(depth = 1): FiberNode[] {
  const root = getRootFiber()
  return root ? walk(root, PREFIX, depth) : []
}

function findByPath(nodes: FiberNode[], path: string): FiberNode | undefined {
  for (const n of nodes) {
    if (n.$path === path) return n
    if (n.children) {
      const found = findByPath(n.children, path)
      if (found) return found
    }
  }
}

function toNode(n: FiberNode): NodeData {
  return { $path: n.$path, $type: n.$type, sourcePath: n.sourcePath } as NodeData
}

export function createFiberTree(): Tree {
  return {
    async get(path) {
      if (path === PREFIX) return { $path: PREFIX, $type: 'dir' } as NodeData
      const node = findByPath(scan(100), path)
      return node ? toNode(node) : undefined
    },

    async getChildren(path, opts?) {
      const depth = opts?.depth ?? 1

      if (path === PREFIX) {
        const nodes = scan(depth)
        return { items: nodes.map(toNode), total: nodes.length }
      }

      const parent = findByPath(scan(100), path)
      const children = parent?.children ?? []
      return { items: children.map(toNode), total: children.length }
    },

    async set() { throw new Error('fiber tree is read-only') },
    async remove() { throw new Error('fiber tree is read-only') },
    async patch() { throw new Error('fiber tree is read-only') },
  }
}

// Mount adapter — same pattern as t.mount.fs, t.mount.mongo
register('t.mount.react', 'mount', () => createFiberTree())
