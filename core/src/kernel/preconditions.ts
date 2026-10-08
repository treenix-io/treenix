import { isDeepStrictEqual } from 'node:util'
import { KernelError } from '#errors'
import { decodeChainNode } from '#kernel/chain-index'
import type { InfluenceContext, InfluenceIndex } from '#kernel/influence'
import type { DomainId, Node, Position, Preconditions, Registry, ScanRange, Selector, StoredNode } from '#kernel/types'

export type ReadDependency =
  | { readonly kind: 'target' | 'rights' | 'type' | 'actor' | 'epoch'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'topology'; readonly key: string; readonly range: ScanRange; readonly value: string }
export interface ReadSet extends Preconditions {
  readonly dependencies?: readonly ReadDependency[]
}
export interface PreconditionOptions extends InfluenceContext {
  readonly index: InfluenceIndex
  readonly position: Position
  readonly read: (path: string) => Promise<Node | null>
  readonly domains: (selector: Selector) => readonly DomainId[]
  readonly dependency: (input: ReadDependency) => unknown | Promise<unknown>
}

/** Rejects a prepared operation when captured dependencies, nodes, or selectors have changed. */
export async function checkPreconditions(expect: ReadSet, options: PreconditionOptions): Promise<void> {
  for (const input of expect.dependencies ?? []) {
    if (!isDeepStrictEqual(input.value, await options.dependency(input))) throw new KernelError('CONFLICT', 'A read dependency changed')
  }
  for (const input of expect.nodes ?? []) {
    const node = await options.read(input.path)
    if (node === null || node.$rev !== input.rev) throw new KernelError('CONFLICT', 'A read node changed')
  }
  for (const path of expect.absent ?? []) {
    if (await options.read(path) !== null) throw new KernelError('CONFLICT', 'A read absence changed')
  }
  for (const input of expect.selectors ?? []) {
    options.index.check(input.selector, input.at, options.position, options.domains(input.selector), options)
  }
}

export function typeReadVersion(registry: Registry, name: string): unknown {
  try {
    const type = registry.type(name)
    return { name: type.name, version: type.version, schema: type.schema,
      rule: registry.security(name, 'acl'), migrations: registry.security(name, 'migrate') }
  } catch (error) {
    if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error
    return { unknown: name }
  }
}

export function rightsReadInput(node: StoredNode | null, registry: Registry): unknown {
  if (node === null) return null
  const rules = new Set<string>()
  for (const name of decodeChainNode(node).types) {
    try {
      const type = registry.type(name)
      if (registry.security(name, 'acl') !== undefined) rules.add(type.name)
    } catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error
      rules.add(name)
    }
  }
  return { acl: node.$acl, owner: node.$owner, rules: [...rules].sort() }
}
