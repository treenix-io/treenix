// The kernel's $in and $nin for sift: their operands are primitives (expr-work refuses others at parse), so a value
// tests through a Set — one lookup instead of one comparison per operand — which is why expr-work weighs them 1.
// $nin follows sift's walk over array elements. sift's CommonJS entry exposes only its default export to ES modules,
// so these are written against its operation protocol rather than imported.

import { type Operand, setOperands } from './expr-work'

type Key = string | number

// As sift compares with a primitive: an object with getTime by that time, one with toJSON by that value. An array
// never equals a primitive, so it is left whole.
function comparable(v: unknown): unknown {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v
  if ('getTime' in v && typeof v.getTime === 'function') return v.getTime()
  if ('toJSON' in v && typeof v.toJSON === 'function') return v.toJSON()
  return v
}

class SetIn {
  keep = false
  done = false
  readonly propop = true
  private readonly set: Set<unknown>
  // sift's equality matches a null operand with undefined too.
  private readonly matchesNull: boolean

  constructor(operands: readonly Operand[]) {
    this.set = new Set(operands)
    this.matchesNull = this.set.has(null)
  }

  reset(): void {
    this.keep = false
    this.done = false
  }

  next(item: unknown): void {
    const v = comparable(item)
    if (v == null ? this.matchesNull : this.set.has(v)) {
      this.keep = true
      this.done = true
    }
  }
}

// Inside an array a value is out of the list only when no element is in it, decided at the last element.
class Nin {
  keep = false
  done = false
  readonly propop = true

  constructor(private readonly within: SetIn) {}

  reset(): void {
    this.keep = false
    this.done = false
    this.within.reset()
  }

  next(item: unknown, key: Key, owner: unknown, root: boolean): void {
    this.within.next(item)

    if (Array.isArray(owner) && !root) {
      if (this.within.keep) {
        this.keep = false
        this.done = true
      } else if (Number(key) === owner.length - 1) {
        this.keep = true
        this.done = true
      }
      return
    }

    this.keep = !this.within.keep
    this.done = true
  }
}

export const SIFT_OPERATIONS = {
  $in: (params: unknown) => new SetIn(setOperands('$in', params)),
  $nin: (params: unknown) => new Nin(new SetIn(setOperands('$nin', params))),
}
