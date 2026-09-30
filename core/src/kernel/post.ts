// A post (T13) declares, per target, the update operators an action applies: `''` is the action's own node, any
// other key one of its `needs`. The guard holds the action to it (A5) and the planner reads it as the effect.

import { isSafeKey } from '#core/json'
import { KernelError } from '#errors'
import { isQueryObject } from './eval-compile'
import type { Post, UpdateOps } from './types'

const OPERATORS = new Set(['$set', '$unset', '$inc', '$push'])

/** INVALID unless `value` is a Post: the four operators over dotted fields, no field touched twice in a target. */
export function assertPost(value: unknown): asserts value is Post {
  if (!isQueryObject(value)) throw new KernelError('INVALID', 'A post maps targets to update operators')

  for (const [target, ops] of Object.entries(value)) {
    if (!isSafeKey(target)) throw new KernelError('INVALID', `Forbidden post target: ${target}`)
    assertUpdateOps(ops, target)
  }
}

function assertUpdateOps(ops: unknown, target: string): asserts ops is UpdateOps {
  if (!isQueryObject(ops)) throw new KernelError('INVALID', `Post target '${target}' takes update operators`)

  const touched: string[] = []
  for (const [op, fields] of Object.entries(ops)) {
    if (!OPERATORS.has(op)) throw new KernelError('INVALID', `Unknown update operator ${op} for post target '${target}'`)
    if (!isQueryObject(fields) || Object.keys(fields).length === 0)
      throw new KernelError('INVALID', `${op} for post target '${target}' takes a non-empty object of fields`)

    for (const [field, operand] of Object.entries(fields)) {
      if (!field.split('.').every((s) => s !== '' && isSafeKey(s)))
        throw new KernelError('INVALID', `Forbidden field ${JSON.stringify(field)} in post target '${target}'`)
      if (op === '$unset' && operand !== true) throw new KernelError('INVALID', `$unset ${field} takes true`)
      if (op === '$inc' && !(typeof operand === 'number' && Number.isFinite(operand)))
        throw new KernelError('INVALID', `$inc ${field} takes a finite number`)

      touched.push(field)
    }
  }

  assertDisjoint(touched, target)
}

// Mongo refuses an update that touches a field twice, or a field and a field inside it: the result would depend on
// the order the operators apply in, and post(before) must be one state.
function assertDisjoint(fields: readonly string[], target: string): void {
  const seen = new Set<string>()
  const parents = new Set<string>()

  for (const field of fields) {
    const segments = field.split('.')
    const ancestors = segments.slice(1).map((_, i) => segments.slice(0, i + 1).join('.'))
    if (seen.has(field) || parents.has(field) || ancestors.some((a) => seen.has(a)))
      throw new KernelError('INVALID', `Post target '${target}' touches ${field} more than once`)

    seen.add(field)
    for (const a of ancestors) parents.add(a)
  }
}
