import { createHash } from 'node:crypto'
import { KernelError } from '#errors'
import { componentEntries, createMigrator } from '#kernel/migrate'
import { assertNodeSchema } from '#kernel/schema'
import { positionToRev } from '#kernel/position'
import { canonical } from '#kernel/registry'
import { A, R, type Bits, type Node, type NodeCopy, type Registry, type Sort, type StoredNode } from '#kernel/types'
import { getByPath } from '#kernel/update-ops'
import { stableJson } from '#util/stable-json'

export interface ProjectionOptions {
  readonly registry: Registry
  readonly alert: (path: string, error: KernelError) => void
}

export function visibleNode(stored: StoredNode, bits: Bits): Node {
  const { $pos, ...body } = stored
  const full: Node = { ...body, $rev: positionToRev($pos) }
  if ((bits & A) !== 0) return full
  const { $acl, $owner, ...plain } = full
  return plain
}

export function createProjector({ registry, alert }: ProjectionOptions) {
  const migrator = createMigrator(type => ({ version: registry.type(type).version, steps: registry.security(type, 'migrate') ?? [] }))
  const signatures = new Map<string, { source: readonly unknown[]; value: string }>()
  const rules = new WeakMap<object, number>()
  let ruleVersion = 0
  function version(type: string): string {
    const def = registry.type(type), acl = registry.security(type, 'acl'), steps = registry.security(type, 'migrate')
    const source = [def, acl, steps], previous = signatures.get(type)
    if (previous !== undefined && previous.source.every((item, i) => item === source[i])) return previous.value
    if (acl !== undefined && !rules.has(acl)) rules.set(acl, ++ruleVersion)
    const value = stableJson([canonical([def.name, def.version, def.schema, acl, steps]), acl && rules.get(acl), migrator.version(type)])
    signatures.set(type, { source, value })
    return value
  }

  return (stored: StoredNode, bits: Bits, sort: Sort = []): NodeCopy | null => {
    if ((bits & R) === 0) return null
    const visible = visibleNode(stored, bits)
    let ver = stableJson([visible.$rev, bits])
    try {
      ver = createHash('sha256').update(stableJson([visible.$rev, bits,
        Object.hasOwn(visible, '$acl'), Object.hasOwn(visible, '$owner'),
        componentEntries(stored).map(([, component]) => [component.$type, version(component.$type)])])).digest('hex')
      const next = migrator.migrate(stored), migrated = next === stored ? visible : visibleNode(next, bits)
      assertNodeSchema(migrated, registry)
      return { node: migrated, bits, ver }
    } catch (cause) {
      console.error(cause)
      const error = cause instanceof KernelError && cause.code === 'INVALID' ? cause : new KernelError('INVALID', 'Node projection failed')
      alert(stored.$path, error)
      if (cause instanceof KernelError && cause.code === 'UNKNOWN_TYPE') return null
      return { id: stored.$id, path: stored.$path, error, ver,
        sort: Object.fromEntries(sort.map(([field]) => [field, structuredClone(getByPath(visible, field))])) }
    }
  }
}
