import { isDeepStrictEqual } from 'node:util'
import { KernelError } from '#errors'
import { decodeChainNode } from '#kernel/chain-index'
import type { InfluenceContext, InfluenceIndex } from '#kernel/influence'
import { revToPosition } from '#kernel/position'
import type { DomainId, Node, Position, Preconditions, Registry, ScanRange, Selector, StoredNode } from '#kernel/types'

export type ReadDependency =
  | { readonly kind: 'target' | 'rights' | 'type' | 'actor' | 'epoch'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'topology'; readonly key: string; readonly range: ScanRange; readonly value: string }
export interface ReadSet extends Preconditions {
  readonly dependencies?: readonly ReadDependency[]
}

/** Aliased selections retain every actual source proof, including hidden and absent sources. */
export function combineReadSets(inputs: readonly ReadSet[]): ReadSet {
  const nodes = new Map<string, string>(), absent = new Set<string>();
  const dependencies = new Map<string, ReadDependency>();
  const selectors: NonNullable<ReadSet['selectors']>[number][] = [];
  for (const input of inputs) {
    for (const node of input.nodes ?? []) {
      if (absent.has(node.path) || nodes.has(node.path) && nodes.get(node.path) !== node.rev)
        throw new KernelError('CONFLICT', 'A source observation changed during the operation');
      nodes.set(node.path, node.rev);
    }
    for (const path of input.absent ?? []) {
      if (nodes.has(path)) throw new KernelError('CONFLICT', 'A source observation changed during the operation');
      absent.add(path);
    }
    for (const dependency of input.dependencies ?? []) {
      const key = `${dependency.kind}:${dependency.key}`;
      const previous = dependencies.get(key);
      if (previous !== undefined && !isDeepStrictEqual(previous, dependency))
        throw new KernelError('CONFLICT', 'A source dependency changed during the operation');
      dependencies.set(key, dependency);
    }
    for (const selector of input.selectors ?? [])
      if (!selectors.includes(selector)) selectors.push(selector);
  }
  return { nodes: [...nodes].map(([path, rev]) => ({ path, rev })), absent: [...absent],
    dependencies: [...dependencies.values()], selectors };
}
export interface PreconditionOptions extends InfluenceContext {
  readonly index: InfluenceIndex
  /** Read-only steps include the actual current cursor; reserved writes remain exclusive. */
  readonly inclusivePosition?: boolean
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
  const pins = new Map<string, string>()
  for (const input of expect.nodes ?? []) {
    const node = await options.read(input.path)
    if (node === null || node.$rev !== input.rev) throw new KernelError('CONFLICT', 'A read node changed')
    pins.set(input.path, input.rev)
  }
  for (const path of expect.absent ?? []) {
    if (await options.read(path) !== null) throw new KernelError('CONFLICT', 'A read absence changed')
  }
  for (const input of expect.selectors ?? []) {
    const pin = 'node' in input.selector ? pins.get(input.selector.node) : undefined
    options.index.check(input.selector, input.at, options.position, options.domains(input.selector), options,
      options.inclusivePosition, pin === undefined ? undefined : revToPosition(pin))
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
