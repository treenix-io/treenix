// Fractional order keys: base-62 digit strings read as fractions in (0, 1). The digits ascend in ASCII, so
// keys compare as plain strings; no key ends in the zero digit, so another key always fits between two.

import { KernelError } from '#errors'
import type { OrderKey } from './types'

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ZERO = DIGITS[0]
const TOP = DIGITS[DIGITS.length - 1]
const MID = DIGITS[DIGITS.length >> 1]
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/

const digitAt = (key: string, i: number): number => DIGITS.indexOf(key[i])

/** A well-formed order key: base-62 digits, not ending in the zero digit. */
export const isOrderKey = (key: unknown): key is OrderKey => typeof key === 'string' && KEY.test(key)

/** A key strictly between `a` and `b`; an absent bound is that open end of the list. */
export function between(a?: OrderKey, b?: OrderKey): OrderKey {
  for (const key of [a, b])
    if (key !== undefined && !isOrderKey(key)) throw new KernelError('INVALID', `Malformed order key: ${JSON.stringify(key)}`)
  if (a !== undefined && b !== undefined && a >= b) throw new KernelError('INVALID', `Order keys out of order: ${a} >= ${b}`)

  if (b === undefined) return a === undefined ? MID : after(a)
  if (a === undefined) return before(b)
  return midpoint(a, b)
}

// The open ends count on levels: level k is k extreme digits (the top one after the list, zero before it) and a
// (k + 1)-digit counter stepped by one with carry. A level holds 61 * 62^k keys, so keys grow logarithmically
// with appends or prepends. Trailing zeros are trimmed: they do not change a key's value.
function after(a: string): string {
  const k = leading(a, TOP)
  return trimZeros(a.slice(0, k) + step(counterAt(a, k), 1))
}

function before(b: string): string {
  const k = leading(b, ZERO)
  const counter = step(counterAt(b, k), -1)
  // The level below starts at its largest counter.
  if (counter[0] === ZERO) return ZERO.repeat(k + 1) + TOP.repeat(k + 2)
  return trimZeros(b.slice(0, k) + counter)
}

function leading(key: string, digit: string): number {
  let k = 0
  while (key[k] === digit) k++
  return k
}

const counterAt = (key: string, k: number): string => key.slice(k, 2 * k + 1).padEnd(k + 1, ZERO)

const trimZeros = (key: string): string => key.replace(/0+$/, '')

// The counter's first digit is never the extreme one the level is made of, so the step never leaves its width.
function step(counter: string, by: 1 | -1): string {
  const digits = [...counter].map((digit) => DIGITS.indexOf(digit))
  for (let i = digits.length - 1; i >= 0; i--) {
    digits[i] += by
    if (digits[i] >= 0 && digits[i] < DIGITS.length) break
    digits[i] = by > 0 ? 0 : DIGITS.length - 1
  }
  return digits.map((d) => DIGITS[d]).join('')
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
