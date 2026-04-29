// Treenix URI — universal intra-node addressing (D17)
// Standard URL order: /path[?query]#[key.]name[()]
// Parsed via native URL — free encoding, edge case handling.
// () = action call, no () = field read
// Query: dot-notation for nesting (age.$gt=10 → { age: { $gt: 10 } })

export interface TreenixURI {
  path: string
  key?: string
  field?: string
  action?: string
  data?: Record<string, unknown>
}

export function parseURI(uri: string): TreenixURI {
  const url = new URL(uri, 'treenix://t')

  const path = url.pathname
  if (!path.startsWith('/')) throw new Error('Path must start with /')

  const result: TreenixURI = { path }

  const fragment = url.hash.slice(1) // strip leading #
  if (fragment) {
    const isCall = fragment.endsWith('()')
    const clean = isCall ? fragment.slice(0, -2) : fragment
    if (!clean) throw new Error('Empty name in URI fragment')

    const dot = clean.indexOf('.')
    const key = dot > -1 ? clean.slice(0, dot) : undefined
    const name = dot > -1 ? clean.slice(dot + 1) : clean
    if (dot > -1 && !name) throw new Error('Empty name in URI fragment')

    if (key) result.key = key
    if (isCall) { result.action = name }
    else if (key) { result.field = name }
    else { result.key = name }
  }

  const data = url.search ? expandDots(url.searchParams) : undefined
  if (data) result.data = data
  return result
}

/** Extract value from node by parsed URI (key + field) */
export function deriveURI<T>(node: Record<string, unknown> | undefined, uri: TreenixURI): T | undefined {
  if (!node) return undefined
  if (!uri.key && !uri.field) return node as T
  const comp = uri.key ? node[uri.key] : node
  if (comp === undefined) return undefined
  if (!uri.field) return comp as T
  return (comp as Record<string, unknown>)?.[uri.field] as T
}

/** Expand URLSearchParams with dot-notation into nested object */
function expandDots(params: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, val] of params) setNested(result, key, coerce(val))
  return result
}

function coerce(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  const n = Number(v)
  if (v !== '' && !isNaN(n)) return n
  return v
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function setNested(obj: Record<string, unknown>, path: string, val: unknown) {
  const parts = path.split('.')
  let cur = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (FORBIDDEN_KEYS.has(p)) return
    if (!(p in cur) || typeof cur[p] !== 'object' || cur[p] === null) {
      cur[p] = Object.create(null)
    }
    cur = cur[p] as Record<string, unknown>
  }

  const last = parts[parts.length - 1]
  if (!FORBIDDEN_KEYS.has(last)) cur[last] = val
}
