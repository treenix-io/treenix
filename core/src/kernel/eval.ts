// The kernel's expression evaluator (A10, §7) reads a node as Mongo reads a document, own fields only. Every step
// of a test — a field read, an array element visited, a value tested — is charged to the operation's counter as it
// is taken, so a test stops the moment the counter passes the limit, whatever the shape of the data.

import { KernelError } from '#errors'
import type { Limits } from './types'

/** The expression work of one operation: every step of every test it runs is charged as it is taken. */
export interface ExprWork {
  readonly limit: number
  used: number
}

export const exprWork = (limits: Limits): ExprWork => ({ limit: limits.exprWork, used: 0 })

/** One step of a test; the step past the operation's limit stops it with BUDGET. */
export function charge(work: ExprWork): void {
  work.used++
  if (work.used > work.limit) throw new KernelError('BUDGET', `Expression work exceeds the limit ${work.limit}`)
}

/** A segment of a dotted path; `index` is the array position it spells canonically, -1 when it spells none. */
interface Segment {
  readonly name: string
  readonly index: number
}

/** A query's dotted field path, split into segments. */
export type FieldPath = readonly Segment[]

/** A test of one value a path reached; `undefined` is a missing value. */
export type ValueTest = (value: unknown, work: ExprWork) => boolean

/** What a query reads fields from: a node, or an array element under an object-form $elemMatch. */
export type Doc = Record<string, unknown> | unknown[]

/** Only a plain object is a document a path enters; a Date or a Map is a value. */
export function isDocument(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// An array read as a document has its positions as fields, as Mongo reads an array element under $elemMatch.
function field(doc: Doc, seg: Segment, work: ExprWork): unknown {
  charge(work)
  if (Array.isArray(doc)) return seg.index >= 0 && seg.index < doc.length ? doc[seg.index] : undefined
  return Object.hasOwn(doc, seg.name) ? doc[seg.name] : undefined
}

// The array a path ends at gives its elements when the condition expands arrays, then itself.
function atEnd(v: unknown, expand: boolean, test: ValueTest, work: ExprWork): boolean {
  if (expand && Array.isArray(v)) {
    for (let j = 0; j < v.length; j++) {
      charge(work)
      if (test(v[j], work)) return true
    }
  }

  charge(work)
  return test(v, work)
}

// The walk of one path: the arrays it is read past, each with the segment read at it and its next element, and the
// value to read next. It keeps its own stack, so the depth of the data never deepens the call stack.
class Walk {
  private readonly arrays: (readonly unknown[])[] = []
  private readonly ats: number[] = []
  private readonly nexts: number[] = []
  value: unknown
  at = 1
  // An element a position ends the path at: tested whole.
  whole = false

  constructor(
    private readonly path: FieldPath,
    first: unknown,
  ) {
    this.value = first
  }

  enter(array: readonly unknown[], at: number): void {
    this.arrays.push(array)
    this.ats.push(at)
    this.nexts.push(0)
  }

  // Past an array a segment reads that field of every element that is a document and then, when it spells a
  // position of the array, the element there: given whole if the path ends at it, entered only if it is a document
  // or an array otherwise. Arrays directly inside arrays are not entered by field.
  advance(work: ExprWork): boolean {
    for (let top = this.arrays.length - 1; top >= 0; top = this.arrays.length - 1) {
      const array = this.arrays[top]
      const at = this.ats[top]
      const seg = this.path[at]

      while (this.nexts[top] < array.length) {
        charge(work)
        const element = array[this.nexts[top]++]
        if (isDocument(element)) return this.moveTo(field(element, seg, work), at + 1, false)
      }

      this.arrays.pop()
      this.ats.pop()
      this.nexts.pop()
      if (seg.index < 0 || seg.index >= array.length) continue

      const positioned = array[seg.index]
      if (at + 1 === this.path.length) return this.moveTo(positioned, at + 1, true)
      if (isDocument(positioned) || Array.isArray(positioned)) return this.moveTo(positioned, at + 1, false)
    }

    return false
  }

  private moveTo(value: unknown, at: number, whole: boolean): true {
    this.value = value
    this.at = at
    this.whole = whole
    return true
  }
}

/** Whether `test` holds for any value `path` reaches in `doc`: a condition matches if any value there matches. */
export function anyAt(doc: Doc, path: FieldPath, expand: boolean, test: ValueTest, work: ExprWork): boolean {
  const walk = new Walk(path, field(doc, path[0], work))

  do {
    if (walk.whole) {
      charge(work)
      if (test(walk.value, work)) return true
      continue
    }

    let v = walk.value
    let i = walk.at
    while (i < path.length && isDocument(v)) v = field(v, path[i++], work)

    if (i === path.length) {
      if (atEnd(v, expand, test, work)) return true
    } else if (Array.isArray(v)) {
      walk.enter(v, i)
    } else {
      charge(work)
      if (test(undefined, work)) return true
    }
  } while (walk.advance(work))

  return false
}
