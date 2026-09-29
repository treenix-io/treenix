// The kernel's $in and $nin for sift: operands that are all primitives test through a Set — one lookup per value
// instead of one comparison per operand — which is why expr-work weighs them 1. Other operands compare as sift
// does. $nin follows sift's walk over array elements. sift's CommonJS entry exposes only its default export to
// ES modules, so these are written against its operation protocol rather than imported.

import { type SetOperand, setOperands } from './expr-work'

type Key = string | number

/** The part of sift's options these operations read: its deep equality. */
interface SiftOptions {
  readonly compare: (a: unknown, b: unknown) => boolean
}

interface InOperation {
  keep: boolean
  reset(): void
  next(item: unknown): void
}

// As sift compares: a Date by its time, an array by its compared elements, an object with toJSON by that value.
function comparable(v: unknown): unknown {
  if (v instanceof Date) return v.getTime()
  if (Array.isArray(v)) return v.map(comparable)
  if (typeof v === 'object' && v !== null && 'toJSON' in v && typeof v.toJSON === 'function') return v.toJSON()
  return v
}

class SetIn implements InOperation {
  keep = false
  done = false
  readonly propop = true
  private readonly set: Set<unknown>
  private readonly matchesNull: boolean

  constructor(operands: readonly SetOperand[]) {
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

class ListIn implements InOperation {
  keep = false
  done = false
  readonly propop = true
  private readonly tests: ((v: unknown) => boolean)[]

  constructor(operands: readonly unknown[], options: SiftOptions) {
    this.tests = operands.map((operand) => {
      const a = comparable(operand)
      return (v) => options.compare(a, v)
    })
  }

  reset(): void {
    this.keep = false
    this.done = false
  }

  next(item: unknown): void {
    const v = comparable(item)
    if (this.tests.some((test) => test(v))) {
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

  constructor(private readonly within: InOperation) {}

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

function inOperation(params: unknown, options: SiftOptions): SetIn | ListIn {
  const operands = setOperands(params)
  return operands ? new SetIn(operands) : new ListIn(Array.isArray(params) ? params : [params], options)
}

export const SIFT_OPERATIONS = {
  $in: (params: unknown, _owner: unknown, options: SiftOptions) => inOperation(params, options),
  $nin: (params: unknown, _owner: unknown, options: SiftOptions) => new Nin(inOperation(params, options)),
}
