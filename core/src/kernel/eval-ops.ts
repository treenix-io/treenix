// What each operator asks of one value, as Mongo answers it for a primitive operand: values compare only within one
// type, a null operand stands for a missing value too, and $in looks the value up in a set.

import { charge, type ExprWork, type ValueTest } from './eval'

/** A comparison operand. NaN is none: JSON cannot carry it, and it equals itself in a set but nowhere else. */
export type Operand = string | number | boolean | null

export const isOperand = (v: unknown): v is Operand =>
  typeof v === 'string' || typeof v === 'boolean' || v === null || (typeof v === 'number' && !Number.isNaN(v))

export type Order = '$gt' | '$gte' | '$lt' | '$lte'

// No order holds for NaN in a node, as in Mongo.
const ORDER: Record<Order, <T extends number | boolean | string>(a: T, b: T) => boolean> = {
  $gt: (a, b) => a > b,
  $gte: (a, b) => a >= b,
  $lt: (a, b) => a < b,
  $lte: (a, b) => a <= b,
}

const isNull = (v: unknown) => v === null || v === undefined

// UTF-16 units reordered into code points: a surrogate (a character above U+FFFF) above U+E000–U+FFFF.
const codePointUnit = (u: number) => (u < 0xd800 ? u : u < 0xe000 ? u + 0x2000 : u - 0x800)

function hasUnitFromD800(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0xd800) return true
  return false
}

// Walked unit by unit, a comparison costs some twenty times a native one, so each block of units it walks past the
// first is a step of its own: a step here then costs about what any other step does, however long the strings.
const UNITS_PER_STEP = 8

function codePointSign(a: string, b: string, work: ExprWork): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % UNITS_PER_STEP === 0) charge(work)

    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x !== y) return codePointUnit(x) - codePointUnit(y)
  }
  return a.length - b.length
}

export function equals(operand: Operand): ValueTest {
  return operand === null ? isNull : (v) => v === operand
}

/**
 * $gte and $lte with null are equality with null, $gt and $lt with null match nothing. Mongo orders strings by
 * UTF-8 bytes, which is code point order; UTF-16 order differs only where a surrogate meets a unit from U+E000 up,
 * so an operand without units from U+D800 up compares natively.
 */
export function compares(op: Order, operand: Operand): ValueTest {
  const order = ORDER[op]
  if (operand === null) return op === '$gte' || op === '$lte' ? isNull : () => false
  if (typeof operand === 'boolean') return (v) => typeof v === 'boolean' && order(v, operand)
  if (typeof operand === 'number') return (v) => typeof v === 'number' && order(v, operand)
  if (!hasUnitFromD800(operand)) return (v) => typeof v === 'string' && order(v, operand)

  return (v, work) => typeof v === 'string' && order(codePointSign(v, operand, work), 0)
}

export function within(operands: readonly Operand[]): ValueTest {
  const set = new Set<unknown>(operands)
  const withNull = set.has(null)
  return (v) => (isNull(v) ? withNull : set.has(v))
}

export const present: ValueTest = (v) => v !== undefined

export const sized = (n: number): ValueTest => (v) => Array.isArray(v) && v.length === n

/** $elemMatch: an array with an element passing `test`; each element visited is a step. */
export function someElement(test: ValueTest): ValueTest {
  return (v, work) => {
    if (!Array.isArray(v)) return false

    for (let j = 0; j < v.length; j++) {
      charge(work)
      if (test(v[j], work)) return true
    }
    return false
  }
}
