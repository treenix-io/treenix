import { comparePaths } from '#core/path'
import { KernelError } from '#errors'
import type { Cursor, ScanResult, Sort } from '#kernel/types'
import { getByPath } from '#kernel/update-ops'
import { stableJson } from '#util/stable-json'
import { isRecord } from '#util/is-record'

type Value = { rank: number; value: null | number | string | boolean }
export interface ScanKey { readonly values: readonly Value[]; readonly key: string }

function value(raw: unknown): Value {
  if (raw === undefined || raw === null) return { rank: 0, value: null }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new KernelError('INVALID', 'A sort number must be finite')
    return { rank: 1, value: raw }
  }
  if (typeof raw === 'string') return { rank: 2, value: raw }
  if (typeof raw === 'boolean') return { rank: 5, value: raw }
  if (typeof raw === 'object') return { rank: Array.isArray(raw) ? 4 : 3, value: stableJson(raw) }
  throw new KernelError('INVALID', 'A sort field must contain JSON data')
}

function compare(a: Value, b: Value): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.value === b.value) return 0
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value < b.value ? -1 : 1
  return comparePaths(String(a.value), String(b.value))
}

function isValue(raw: unknown): raw is Value {
  if (!isRecord(raw)) return false
  switch (raw.rank) {
    case 0: return raw.value === null
    case 1: return typeof raw.value === 'number' && Number.isFinite(raw.value)
    case 2: case 3: case 4: return typeof raw.value === 'string'
    case 5: return typeof raw.value === 'boolean'
    default: return false
  }
}

/** Decodes an external cursor and rejects reuse with a different query scope or sort width. */
export function parseScanCursor(cursor: Cursor, scope: string, width: number): ScanKey {
  let raw: unknown
  try { raw = JSON.parse(cursor) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    console.error(error)
    throw new KernelError('INVALID', 'Malformed scan cursor')
  }
  if (!isRecord(raw) || raw.scope !== scope || typeof raw.key !== 'string' || !Array.isArray(raw.values)
    || raw.values.length !== width || !raw.values.every(isValue)) throw new KernelError('INVALID', 'Cursor belongs to another scan')
  return { key: raw.key, values: raw.values }
}

/** Builds the shared JSON ordering key, using the path to break ties. */
export function scanKey(item: object, sort: Sort, key: string, fieldValue: (item: object, field: string) => unknown = getByPath): ScanKey {
  return { values: sort.map(([field]) => value(fieldValue(item, field))), key }
}

/** Compares projected sort values and then the stable path key. */
export function compareScanKeys(a: ScanKey, b: ScanKey, sort: Sort): number {
  for (let i = 0; i < sort.length; i++) {
    const difference = compare(a.values[i], b.values[i]) * sort[i][1]
    if (difference !== 0) return difference
  }
  return comparePaths(a.key, b.key)
}

/** Encodes the last ordering key together with its originating query scope. */
export function scanCursor(scope: string, key: ScanKey): Cursor {
  return stableJson({ scope, values: key.values, key: key.key })
}

export function scanPage<T extends object>(items: readonly T[], sort: Sort, key: (item: T) => string,
  scope: string, after: Cursor | undefined, limit: number | undefined, check: () => void): ScanResult<T> {
  check()
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new KernelError('INVALID', 'Scan limit must be a positive integer')
  const cursor = after === undefined ? undefined : parseScanCursor(after, scope, sort.length)
  const rows = items.map(item => {
    check()
    return { item, ...scanKey(item, sort, key(item)) }
  })
  const order = (a: ScanKey, b: ScanKey): number => {
    check()
    return compareScanKeys(a, b, sort)
  }
  rows.sort(order)
  const eligible = cursor === undefined ? rows : rows.filter(row => order(row, cursor) > 0)
  const page = limit === undefined ? eligible : eligible.slice(0, limit)
  const last = page.at(-1)
  const output = page.map(row => {
    check()
    return structuredClone(row.item)
  })
  check()
  return {
    items: output,
    ...last !== undefined && page.length < eligible.length ? { next: scanCursor(scope, last) } : {},
  }
}
