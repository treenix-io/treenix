import { isSafeKey } from '#core/json'
import { KernelError } from '#errors'
import { isRecord } from '#util/is-record'
import type { Delta, UpdateOps } from './types'

const safeSegment = (name: string) => name !== '' && !name.includes('\0') && isSafeKey(name)

export function assertSafePatchPath(path: string, code: 'FORBIDDEN' | 'INVALID' = 'FORBIDDEN'): void {
  if (typeof path !== 'string')
    throw new KernelError(code, `Invalid patch path: ${JSON.stringify(path)}`)
  for (const part of path.split('.')) {
    if (!safeSegment(part)) throw new KernelError(code, `Forbidden patch segment in ${JSON.stringify(path)}`)
  }
}

/** Stores reject prototype keys on read, so a written one would make the node unreadable. */
export function assertNoPrototypeKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrototypeKeys(item, path)
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeKey(key)) throw new KernelError('INVALID', `${path}: forbidden prototype key ${JSON.stringify(key)}`)
    assertNoPrototypeKeys(item, path)
  }
}

export function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = Reflect.get(current, key)
  }
  return current
}

// Bounding indices prevents a patch from creating a huge sparse array.
function arrayIndex(arr: unknown[], key: string, max: number, path: string, code: 'INVALID' | 'NOT_FOUND' = 'INVALID'): number {
  const index = Number(key)
  if (!Number.isInteger(index) || index < 0 || index > max || String(index) !== key)
    throw new KernelError(code, `Array index ${JSON.stringify(key)} out of range (length ${arr.length}) in ${path}`)
  return index
}

export function setByPath(obj: object, path: string, value: unknown, strict = false): void {
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = Array.isArray(current) ? arrayIndex(current, parts[i], current.length - 1, path) : parts[i]
    const next: unknown = Reflect.get(current, key)
    if (next === null || typeof next !== 'object') {
      const at = parts.slice(0, i + 1).join('.')
      if (strict) throw new KernelError('NOT_FOUND', `Missing parent ${at} in ${path}`)
      if (next != null) throw new KernelError('INVALID', `${at} is not an object in ${path}`)
      const parent = {}
      if (!Reflect.set(current, key, parent)) throw new KernelError('INVALID', `Cannot write ${path}`)
      current = parent
    } else current = next
  }
  const last = parts[parts.length - 1]
  const key = Array.isArray(current) ? arrayIndex(current, last, strict ? current.length - 1 : current.length, path) : last
  if (!Reflect.set(current, key, value)) throw new KernelError('INVALID', `Cannot write ${path}`)
}

export function deleteByPath(obj: object, path: string, strict = true, arrayMode: 'splice' | 'null' = 'splice'): void {
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    let key: string | number = parts[i]
    if (Array.isArray(current)) {
      key = arrayIndex(current, parts[i], strict ? current.length - 1 : Number.MAX_SAFE_INTEGER, path, strict ? 'NOT_FOUND' : 'INVALID')
      if (key >= current.length) return
    }
    const next: unknown = Reflect.get(current, key)
    if (next === null || typeof next !== 'object') {
      if (!strict) return
      throw new KernelError('NOT_FOUND', `Missing parent in ${path}`)
    }
    current = next
  }
  const key = parts[parts.length - 1]
  if (Array.isArray(current)) {
    const at = arrayIndex(current, key, strict ? current.length - 1 : Number.MAX_SAFE_INTEGER, path, strict ? 'NOT_FOUND' : 'INVALID')
    if (at >= current.length) return
    if (arrayMode === 'null') current[at] = null
    else current.splice(at, 1)
    return
  }
  if (!Object.hasOwn(current, key)) {
    if (!strict) return
    throw new KernelError('NOT_FOUND', `Missing key ${JSON.stringify(key)} in ${path}`)
  }
  if (!Reflect.deleteProperty(current, key)) throw new KernelError('INVALID', `Cannot delete ${path}`)
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new KernelError('INVALID', 'Update operators and deltas take plain objects')
}

type FieldTrie = { terminal: boolean; children: Map<string, FieldTrie> }

function assertDisjoint(fields: readonly string[]): void {
  const root: FieldTrie = { terminal: false, children: new Map() }
  for (const field of fields) {
    let branch = root
    for (const segment of field === '' ? [] : field.split('.')) {
      if (branch.terminal) throw new KernelError('INVALID', `Overlapping update path ${JSON.stringify(field)}`)
      let child = branch.children.get(segment)
      if (!child) {
        child = { terminal: false, children: new Map() }
        branch.children.set(segment, child)
      }
      branch = child
    }
    if (branch.terminal || branch.children.size)
      throw new KernelError('INVALID', `Overlapping update path ${JSON.stringify(field)}`)
    branch.terminal = true
  }
}

const OPERATORS = new Set(['$set', '$unset', '$inc', '$push'])

export function assertUpdateOps(value: unknown): asserts value is UpdateOps {
  assertObject(value)
  const touched: string[] = []
  for (const [operator, fields] of Object.entries(value)) {
    if (!OPERATORS.has(operator)) throw new KernelError('INVALID', `Unknown update operator ${operator}`)
    assertObject(fields)
    if (Object.keys(fields).length === 0) throw new KernelError('INVALID', `${operator} takes a non-empty object of fields`)
    for (const [field, operand] of Object.entries(fields)) {
      assertSafePatchPath(field, 'INVALID')
      if (operator === '$unset' && operand !== true) throw new KernelError('INVALID', `$unset ${field} takes true`)
      if (operator === '$inc' && !(typeof operand === 'number' && Number.isFinite(operand)))
        throw new KernelError('INVALID', `$inc ${field} takes a finite number`)
      if (operator === '$set' || operator === '$push') assertNoPrototypeKeys(operand, field)
      touched.push(field)
    }
  }
  assertDisjoint(touched)
}

/** Operates on an owned copy: a failed operator cannot publish a partial transition. */
export function applyUpdateOps<T extends Record<string, unknown>>(before: T, ops: UpdateOps): T {
  assertUpdateOps(ops)
  const next = structuredClone(before)
  if (ops.$set) for (const [field, value] of Object.entries(ops.$set)) setByPath(next, field, structuredClone(value))
  if (ops.$unset) for (const field of Object.keys(ops.$unset)) deleteByPath(next, field, false, 'null')
  if (ops.$inc) for (const [field, amount] of Object.entries(ops.$inc)) {
    const current = getByPath(next, field)
    if (current !== undefined && !(typeof current === 'number' && Number.isFinite(current)))
      throw new KernelError('INVALID', `$inc ${field} needs a finite number`)
    const value = (current === undefined ? 0 : current) + amount
    if (!Number.isFinite(value)) throw new KernelError('INVALID', `$inc ${field} overflows`)
    setByPath(next, field, value)
  }
  if (ops.$push) for (const [field, value] of Object.entries(ops.$push)) {
    const current = getByPath(next, field)
    if (current === undefined) setByPath(next, field, [structuredClone(value)])
    else if (Array.isArray(current)) current.push(structuredClone(value))
    else throw new KernelError('INVALID', `$push ${field} needs an array`)
  }
  return next
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
}

export function computeDelta(before: Record<string, unknown>, after: Record<string, unknown>): Delta {
  assertNoPrototypeKeys(after, '')
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  function visit(left: unknown, right: unknown, path: string): void {
    if (left === right) return
    // A literal dot or empty JSON key cannot be addressed below its containing object.
    if (isRecord(left) && isRecord(right)) {
      const addressable = (key: string) => safeSegment(key) && !key.includes('.')
      const literalChanged = [...Object.keys(left), ...Object.keys(right)].some((key) => !addressable(key)
        && (Object.hasOwn(left, key) !== Object.hasOwn(right, key) || !equalJson(left[key], right[key])))
      if (literalChanged) {
        set[path] = structuredClone(right)
        return
      }
      for (const key of Object.keys(left)) {
        if (!Object.hasOwn(right, key)) unset.push(path ? `${path}.${key}` : key)
      }
      for (const [key, value] of Object.entries(right)) {
        if (!addressable(key)) continue // Already proven unchanged above.
        const field = path ? `${path}.${key}` : key
        if (Object.hasOwn(left, key)) visit(left[key], value, field)
        else set[field] = structuredClone(value)
      }
    } else if (!equalJson(left, right)) set[path] = structuredClone(right)
  }
  visit(before, after, '')
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) }
}

export function applyDelta<T extends Record<string, unknown>>(before: T, delta: Delta): T {
  assertObject(delta)
  const fields: string[] = []
  for (const key of Object.keys(delta)) if (key !== 'set' && key !== 'unset') throw new KernelError('INVALID', `Unknown delta member ${key}`)
  if (delta.set !== undefined) {
    assertObject(delta.set)
    for (const [field, value] of Object.entries(delta.set)) {
      if (field === '') assertObject(value)
      else assertSafePatchPath(field, 'INVALID')
      assertNoPrototypeKeys(value, field)
      fields.push(field)
    }
  }
  if (delta.unset !== undefined) {
    if (!Array.isArray(delta.unset)) throw new KernelError('INVALID', 'Delta unset takes an array of paths')
    for (const field of delta.unset) {
      assertSafePatchPath(field, 'INVALID')
      fields.push(field)
    }
  }
  assertDisjoint(fields)
  const next = structuredClone(before)
  if (delta.set) for (const [field, value] of Object.entries(delta.set)) {
    if (field === '') {
      for (const key of Object.keys(next)) Reflect.deleteProperty(next, key)
      Object.assign(next, structuredClone(value))
    } else setByPath(next, field, structuredClone(value))
  }
  if (delta.unset) for (const field of delta.unset) deleteByPath(next, field, false)
  return next
}
