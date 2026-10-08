import { isDeepStrictEqual } from 'node:util'
import { KernelError } from '#errors'
import { decodeChainNode } from '#kernel/chain-index'
import type { NodeChange } from '#kernel/changeset'
import { componentEntries, createMigrator } from '#kernel/migrate'
import { assertPost } from '#kernel/post'
import type { Component, Path, Registry, StoredNode, TypeName, UpdateOps } from '#kernel/types'
import { applyUpdateOps } from '#kernel/update-ops'

export interface ActionProvenance {
  readonly type: TypeName
  readonly action: string
  readonly path: Path
  readonly targets?: Readonly<Record<string, readonly Path[]>>
}
export interface ActionGuardOptions {
  readonly registry: Registry
  readonly source?: ActionProvenance
  readonly admin: boolean
  readonly readBefore: (path: Path) => Promise<StoredNode | null>
}

function body(node: Readonly<Record<string, unknown>>, created: boolean): Record<string, unknown> {
  const { $pos, $rev, ...fields } = node
  if (created) Reflect.deleteProperty(fields, '$id')
  return fields
}

export async function guardAction(changes: readonly NodeChange[], { registry, source, admin, readBefore }: ActionGuardOptions): Promise<void> {
  const definition = source === undefined ? undefined : registry.type(source.type)
  const action = source !== undefined && definition !== undefined && Object.hasOwn(definition.actions, source.action)
    ? definition.actions[source.action] : undefined
  if (source !== undefined) {
    const node = await readBefore(source.path)
    if (action === undefined || action.kind === 'read' || node === null
      || !decodeChainNode(node).types.some(type => registry.type(type).name === definition!.name)) {
      throw new KernelError('INVALID', 'The action provenance is not a declared writing action')
    }
  }
  if (!admin) for (const change of changes) for (const node of [change.before, change.after]) {
    if (node === null) continue
    for (const name of decodeChainNode(node).types) {
      const type = registry.type(name)
      if (type.actionsOnly && type.name !== definition?.name) throw new KernelError('FORBIDDEN', 'This type changes only through its own actions')
    }
  }
  if (action === undefined || action.kind === 'read' || action.post === undefined || source === undefined) return
  assertPost(action.post)
  const targets = new Map<Path, UpdateOps[]>()
  for (const [name, ops] of Object.entries(action.post)) {
    const paths = name === '' ? [source.path] : source.targets?.[name]
    if (paths === undefined || name !== '' && !Object.hasOwn(action.needs ?? {}, name)) throw new KernelError('INVALID', 'The post target was not resolved from a declared need')
    for (const path of paths) {
      let updates = targets.get(path)
      if (updates === undefined) { updates = []; targets.set(path, updates) }
      updates.push(ops)
    }
  }
  const after = new Map<Path, StoredNode | null>()
  for (const change of changes) {
    const target = change.before?.$path ?? change.after!.$path
    if (!targets.has(target) || change.after === null) throw new KernelError('FORBIDDEN', 'A write is outside the declared post frame')
    if (change.before !== null) after.set(change.before.$path, null)
  }
  for (const change of changes) if (change.after !== null) after.set(change.after.$path, change.after)
  const migrator = createMigrator(type => ({ version: registry.type(type).version, steps: registry.security(type, 'migrate') ?? [] }))
  for (const [path, updates] of targets) {
    const before = await readBefore(path)
    let expected: Record<string, unknown> = before === null ? { $path: path } : migrator.migrate(before)
    for (const ops of updates) expected = applyUpdateOps(expected, ops)
    if (typeof expected.$type !== 'string' || typeof expected.$path !== 'string') throw new KernelError('INVALID', 'The post result is not a node')
    const component: Component = { ...expected, $type: expected.$type }
    migrator.stamp(component)
    Reflect.set(component, '$type', registry.type(component.$type).name)
    for (const [name, value] of componentEntries(component)) if (name !== '') Reflect.set(value, '$type', registry.type(value.$type).name)
    const next = after.has(expected.$path) ? after.get(expected.$path)! : await readBefore(expected.$path)
    if (next === null || !isDeepStrictEqual(body(component, before === null), body(next, before === null))) {
      throw new KernelError('FORBIDDEN', 'The result differs from the declared post frame')
    }
  }
}
