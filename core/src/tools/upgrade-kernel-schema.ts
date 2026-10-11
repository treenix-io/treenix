import { assertSafeSchema, validateComponent } from '#comp/validate'
import { KernelError } from '#errors'
import type { Registry } from '#kernel/types'
import { componentEntries } from '#kernel/migrate'
import type { UpgradeOptions } from '#tools/upgrade-kernel-plan'

/** Use actual installed type ownership; unknown or invalid documents cannot be applied. */
export function nativeUpgradeValidator(registry: Registry): UpgradeOptions['validate'] {
  return component => {
    if (typeof component.$type !== 'string') return ['MISSING_COMPONENT_TYPE']
    const errors: string[] = []
    let entries
    try { entries = componentEntries({ ...component, $type: component.$type }) }
    catch (error) {
      if (!(error instanceof KernelError && error.code === 'INVALID')) throw error
      return ['INVALID_COMPONENT']
    }
    for (const [name, value] of entries) {
      let definition
      try { definition = registry.type(value.$type) }
      catch (error) {
        if (!(error instanceof KernelError && error.code === 'UNKNOWN_TYPE')) throw error
        errors.push(`UNREGISTERED_TYPE:${name}`)
        continue
      }
      assertSafeSchema(definition.schema, definition.name)
      if ((value.$v ?? 0) !== definition.version) errors.push(`COMPONENT_MIGRATION_REQUIRED:${name}`)
      for (const error of validateComponent(value, definition.schema, name)) errors.push(`SCHEMA_INVALID:${error.path}`)
    }
    return errors
  }
}
