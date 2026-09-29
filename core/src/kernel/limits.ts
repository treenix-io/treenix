// Limits are data: the admin-written node /sys/limits overlays DEFAULT_LIMITS field by field, so an absent
// field keeps its default and an edit applies on the next read.

import { isOwnField } from '#comp/validate'
import { KernelError } from '#errors'
import { DEFAULT_LIMITS, type Limits, type Node } from './types'

const isLimitName = (field: string): field is keyof Limits => Object.hasOwn(DEFAULT_LIMITS, field)

/** The limits in force: the main-component fields of the /sys/limits node over DEFAULT_LIMITS. */
export function readLimits(node: Node): Limits {
  const limits: Record<keyof Limits, number> = { ...DEFAULT_LIMITS }

  for (const [field, value] of Object.entries(node)) {
    if (!isOwnField(field)) continue
    if (!isLimitName(field)) throw new KernelError('INVALID', `${node.$path}: unknown limit ${field}`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new KernelError('INVALID', `${node.$path}: limit ${field} must be a non-negative number, got ${JSON.stringify(value)}`)

    limits[field] = value
  }

  return limits
}
