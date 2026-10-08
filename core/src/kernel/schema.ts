import { assertSafeSchema, validateComponent } from '#comp/validate'
import { KernelError } from '#errors'
import { componentEntries } from '#kernel/migrate'
import { isOrderKey } from '#kernel/order'
import type { Component, Registry } from '#kernel/types'

export function assertNodeSchema(node: Component, registry: Registry): void {
  for (const [name, component] of componentEntries(node)) {
    const def = registry.type(component.$type)
    assertSafeSchema(def.schema, def.name)
    if ((component.$v ?? 0) !== def.version) throw new KernelError('INVALID', 'Component version differs from the current schema')
    if (component.$order !== undefined && !isOrderKey(component.$order)) throw new KernelError('INVALID', 'Invalid component order')
    const errors = validateComponent(component, def.schema, name)
    if (errors.length !== 0) throw new KernelError('INVALID', `Schema violation: ${errors.map(error => `${error.path}: ${error.message}`).join('; ')}`)
  }
}
