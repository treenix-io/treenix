// Fractional order keys: base-62 digit strings read as fractions in (0, 1). The digits ascend in ASCII, so
// keys compare as plain strings; no key ends in the zero digit, so another key always fits between two.

import { KernelError } from '#errors'
import type { OrderKey } from './types'

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const MID = DIGITS[DIGITS.length >> 1]
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/

const digitAt = (key: string, i: number): number => DIGITS.indexOf(key[i])

/** A key strictly between `a` and `b`; an absent bound is that open end of the list. */
export function between(a?: OrderKey, b?: OrderKey): OrderKey {
  for (const key of [a, b])
    if (key !== undefined && !KEY.test(key)) throw new KernelError('INVALID', `Malformed order key: ${JSON.stringify(key)}`)
  if (a !== undefined && b !== undefined && a >= b) throw new KernelError('INVALID', `Order keys out of order: ${a} >= ${b}`)

  if (b === undefined) return a === undefined ? MID : after(a)
  if (a === undefined) return before(b)
  return midpoint(a, b)
}

// The open ends step one digit instead of halving the gap: appending at one end lengthens keys by one
// character per ~30 inserts, not per ~6.
function after(a: string): string {
  for (let i = 0; i < a.length; i++) {
    const d = digitAt(a, i)
    if (d < DIGITS.length - 1) return a.slice(0, i) + DIGITS[d + 1]
  }
  return a + MID
}

function before(b: string): string {
  let i = 0
  while (b[i] === '0') i++

  const d = digitAt(b, i)
  return d > 1 ? b.slice(0, i) + DIGITS[d - 1] : b.slice(0, i) + DIGITS[0] + MID
}

// a < b. Inside the recursion a may be '' (zero) and b absent (one).
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined) {
    let n = 0
    while ((a[n] ?? DIGITS[0]) === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }

  const da = a ? digitAt(a, 0) : 0
  const db = b !== undefined ? digitAt(b, 0) : DIGITS.length
  if (db - da > 1) return DIGITS[(da + db) >> 1]
  if (b !== undefined && b.length > 1) return b[0]
  return DIGITS[da] + midpoint(a.slice(1), undefined)
}
