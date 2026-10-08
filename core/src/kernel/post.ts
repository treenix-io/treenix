// A post (T13) declares, per target, the update operators an action applies: `''` is the action's own node, any
// other key one of its `needs`. The guard holds the action to it (A5) and the planner reads it as the effect.

import { isSafeKey } from '#core/json'
import { KernelError } from '#errors'
import { isQueryObject } from './eval-compile'
import type { Post } from './types'
import { assertUpdateOps } from './update-ops'

/** INVALID unless `value` is a Post: the four operators over dotted fields, no field touched twice in a target. */
export function assertPost(value: unknown): asserts value is Post {
  if (!isQueryObject(value)) throw new KernelError('INVALID', 'A post maps targets to update operators')

  for (const [target, ops] of Object.entries(value)) {
    if (!isSafeKey(target)) throw new KernelError('INVALID', `Forbidden post target: ${target}`)
    assertUpdateOps(ops)
  }
}
