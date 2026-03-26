// TreeP Protocol — URI-driven dispatch over Tree interface
// 3 methods: get / set / remove. URI form determines behavior.

import type { NodeData } from '#core'
import type { Tree, ChildrenOpts } from '#tree'
import type { PatchOp } from '#tree/patch'
import { parseURI, deriveURI } from '#uri'

// ── Types ──

export type ActionExecutor = (
  path: string, key: string | undefined,
  action: string, data?: unknown,
) => Promise<unknown>

export interface TreeP {
  get(uri: string, opts?: { children?: boolean; limit?: number; offset?: number }): Promise<unknown>
  set(uri: string, data?: unknown): Promise<unknown>
  remove(uri: string): Promise<void>
}

// ── Error ──

export class TreePError extends Error {
  type: string
  status: number
  title: string
  detail?: string
  path?: string

  constructor(type: string, status: number, title: string, detail?: string, path?: string) {
    super(detail ?? title)
    this.type = type
    this.status = status
    this.title = title
    if (detail) this.detail = detail
    if (path) this.path = path
  }
}

function badRequest(title: string, detail?: string, path?: string): TreePError {
  return new TreePError('tree:bad-request', 400, title, detail, path)
}

// ── Validation ──

const VALID_OPS = new Set(['t', 'r', 'a', 'd'])

function validatePatchOps(data: unknown[]): PatchOp[] {
  for (const op of data) {
    if (!Array.isArray(op) || op.length < 2 || typeof op[1] !== 'string' || !VALID_OPS.has(op[0])) {
      throw badRequest('Invalid PatchOp', `Expected [op, path, value?], got ${JSON.stringify(op)}`)
    }
  }
  return data as PatchOp[]
}

function safeParse(uri: string) {
  try {
    return parseURI(uri)
  } catch (e) {
    throw badRequest('Invalid URI', (e as Error).message)
  }
}

// Trailing slash detection on parsed path (not raw URI — raw breaks with query params)
function isChildrenPath(parsed: { path: string }): boolean {
  return parsed.path.length > 1 && parsed.path.endsWith('/')
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/$/, '') || '/'
}

// ── Factory ──

export function createTreeP(tree: Tree, execute?: ActionExecutor): TreeP {
  return {

    async get(uri, opts) {
      const parsed = safeParse(uri)
      const hasFragment = !!(parsed.key || parsed.field || parsed.action)

      if (parsed.action) {
        throw badRequest('Cannot GET an action URI', `Use set() for actions: ${uri}`, parsed.path)
      }

      // Children: trailing slash on path or explicit opts.children
      if (isChildrenPath(parsed) || (!hasFragment && opts?.children)) {
        const parentPath = stripTrailingSlash(parsed.path)
        const childOpts: ChildrenOpts = {}
        if (opts?.limit) childOpts.limit = opts.limit
        if (opts?.offset) childOpts.offset = opts.offset
        return tree.getChildren(parentPath, childOpts)
      }

      const node = await tree.get(parsed.path)
      if (!node) return undefined

      return hasFragment ? deriveURI(node, parsed) : node
    },

    async set(uri, data) {
      const parsed = safeParse(uri)

      if (isChildrenPath(parsed)) {
        throw badRequest('Cannot SET on children URI', 'Use node path without trailing slash', parsed.path)
      }
      if (parsed.action) {
        if (!execute) throw badRequest('Action dispatch not configured', `No executor for ${uri}`, parsed.path)
        return execute(parsed.path, parsed.key, parsed.action, data)
      }

      // Field set → patch
      if (parsed.key || parsed.field) {
        const fieldPath = parsed.field ? `${parsed.key}.${parsed.field}` : parsed.key!
        await tree.patch(parsed.path, [['r', fieldPath, data]])
        return
      }

      // Patch ops (array) vs full node replace (object with $path)
      if (Array.isArray(data)) {
        await tree.patch(parsed.path, validatePatchOps(data))
      } else if (data && typeof data === 'object' && '$path' in data) {
        // URI is authoritative — override $path to prevent writes to wrong location
        const node = { ...(data as Record<string, unknown>), $path: parsed.path } as NodeData
        await tree.set(node)
      } else {
        throw badRequest('set() data must be a node (with $path) or PatchOp[]', undefined, parsed.path)
      }
    },

    async remove(uri) {
      const parsed = safeParse(uri)

      if (parsed.key || parsed.field || parsed.action || isChildrenPath(parsed)) {
        throw badRequest('remove() requires a plain path', `Cannot remove: ${uri}`, parsed.path)
      }

      await tree.remove(parsed.path)
    },
  }
}
