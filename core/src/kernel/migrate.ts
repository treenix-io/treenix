import { KernelError } from '#errors'
import type { Component, Migration } from '#kernel/types'
import { isRecord } from '#util/is-record'

export interface MigrationSource {
  readonly version: number
  readonly steps: readonly Migration[]
}
interface MigrationInfo extends MigrationSource { readonly generation: number }

function assertComponent(value: unknown, name: string): asserts value is Component {
  if (!isRecord(value) || typeof value.$type !== 'string') throw new KernelError('INVALID', `Malformed component: ${name}`)
}

export function componentEntries(node: Component): readonly (readonly [string, Component])[] {
  const main: Component = { ...Object.fromEntries(Object.entries(node).filter(([key]) => !key.startsWith('$') && !key.startsWith('#'))),
    $type: node.$type, ...(node.$v === undefined ? {} : { $v: node.$v }), ...(node.$order === undefined ? {} : { $order: node.$order }) }
  const entries: (readonly [string, Component])[] = [['', main]]
  for (const [name, value] of Object.entries(node)) if (name.startsWith('#')) {
    assertComponent(value, name)
    entries.push([name, value])
  }
  return entries
}

export function createMigrator(resolve: (type: string) => MigrationSource | undefined) {
  const info = new Map<string, MigrationInfo | undefined>()
  const checked = new WeakMap<object, { types: readonly string[]; versions: readonly (MigrationInfo | undefined)[] }>()
  let generation = 0

  function descriptor(type: string): MigrationInfo | undefined {
    const source = resolve(type), previous = info.get(type)
    if (source === undefined) { info.delete(type); return undefined }
    if (previous !== undefined && previous.version === source.version && previous.steps.length === source.steps.length
      && previous.steps.every((step, i) => step.from === source.steps[i].from && step.to === source.steps[i].to && step.up === source.steps[i].up)) return previous
    if (!Number.isSafeInteger(source.version) || source.version < 0) throw new KernelError('INVALID', 'Invalid migration version')
    const starts = new Set<number>()
    for (const step of source.steps) {
      if (!Number.isSafeInteger(step.from) || !Number.isSafeInteger(step.to) || step.from < 0 || step.to <= step.from
        || step.to > source.version || starts.has(step.from)) throw new KernelError('INVALID', 'Invalid migration ladder')
      starts.add(step.from)
    }
    const current = { version: source.version, steps: [...source.steps], generation: ++generation }
    info.set(type, current)
    return current
  }

  function migrate(component: Component, source: MigrationInfo | undefined): Component {
    if (source === undefined) return component
    let version = component.$v ?? 0
    if (!Number.isSafeInteger(version) || version < 0 || version > source.version) throw new KernelError('INVALID', 'Invalid stored component version')
    if (version === source.version) return component
    let result = structuredClone(component)
    while (version < source.version) {
      const step = source.steps.find(candidate => candidate.from === version)
      if (step === undefined) throw new KernelError('INVALID', 'Missing migration step')
      result = step.up(result)
      assertComponent(result, component.$type)
      if (result.$type !== component.$type || Object.keys(result).some(key => key.startsWith('#')
        || key.startsWith('$') && !['$type', '$v', '$order'].includes(key))) throw new KernelError('INVALID', 'Migration changes component identity or node metadata')
      version = step.to
      result = { ...result, $v: version }
    }
    return result
  }

  return {
    version(type: string): number { return descriptor(type)?.generation ?? 0 },
    migrate<T extends Component>(node: T): T {
      const previous = checked.get(node)
      if (previous !== undefined && previous.types.every((type, i) => descriptor(type) === previous.versions[i])) return node
      const entries = componentEntries(node), types = entries.map(([, component]) => component.$type), versions = types.map(descriptor)
      const migrated = entries.map(([, component], i) => migrate(component, versions[i]))
      if (entries.every(([, component], i) => component === migrated[i])) { checked.set(node, { types, versions }); return node }
      const result = { ...node }
      // The main step owns only its fields; removed fields must not survive the merge with node metadata.
      for (const key of Object.keys(result)) if (!key.startsWith('$') && !key.startsWith('#')) Reflect.deleteProperty(result, key)
      Object.assign(result, migrated[0])
      for (let i = 1; i < entries.length; i++) Object.defineProperty(result, entries[i][0], { value: migrated[i], enumerable: true, writable: true, configurable: true })
      checked.set(result, { types, versions })
      return result
    },
    stamp(node: Component): void {
      const entries = componentEntries(node).map(([name, component]) => ({ name, component, source: descriptor(component.$type) }))
      for (const { component, source } of entries) if (source !== undefined) {
        if (component.$v !== undefined && component.$v !== source.version) throw new KernelError('INVALID', 'Write component version differs from the current schema')
      }
      for (const { name, component, source } of entries) if (source !== undefined) {
        Reflect.set(name === '' ? node : component, '$v', source.version)
      }
    },
  }
}
