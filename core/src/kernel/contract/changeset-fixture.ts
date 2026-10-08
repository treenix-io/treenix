import type { PositionCounter } from '#kernel/types'
import { createProcessCache } from '#kernel/cache'
import { createChainIndex, decodeChainNode } from '#kernel/chain-index'
import { rightsReadInput, typeReadVersion } from '#kernel/preconditions'
import { createProjector } from '#kernel/projection'
import { computeRights } from '#kernel/rights'
import { prepareChangeSet, type ChangeExecutor, type ChangeSetOptions } from '#kernel/changeset'
import { createRegistry } from '#kernel/registry'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import type { ChangeMember, NodeInput, Position, StoredNode } from '#kernel/types'
import { createWriter } from '#kernel/writer'

export const input = (path: string, fields: Record<string, unknown> = {}, type = 'item'): NodeInput => ({ ...fields, $path: path, $type: type })
export const put = (path: string, fields: Record<string, unknown> = {}, type = 'item'): ChangeMember => ({ op: 'put', node: input(path, fields, type) })

export async function fixture(overrides: Partial<ChangeSetOptions> = {}) {
  const store = overrides.store ?? createMemoryStore({ domain: 'memory' }), cache = overrides.cache ?? createProcessCache()
  const registry = overrides.registry ?? createRegistry()
  if (overrides.registry === undefined) registry.publish({ id: 'test', security: [], open: [], types: [
    { name: 'item', aliases: ['old.item'], module: 'test', security: 'ordinary', version: 1, schema: {}, actions: {} },
    { name: 'extra', aliases: ['old.extra'], module: 'test', security: 'ordinary', version: 2, schema: {}, actions: {} },
    ...['dir', 'other'].map(name => ({ name, module: 'test', security: 'ordinary', version: 0, schema: {}, actions: {} } as const)),
  ] })
  let saved: Position | undefined
  const counter: PositionCounter = {
    async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 },
  }
  const writer = await createWriter({ instance: 'test', root: store, writerEpoch: 1, counter, cache,
    domains: [{ store, epoch: 'memory1', persistent: false }] })
  const options: ChangeSetOptions = { store, cache, registry, budget: scanBudget(), ...overrides }
  const commit = (changes: readonly ChangeMember[], who?: ChangeExecutor) => writer.commit(store, [], async pos => {
    if (who === undefined || !('actor' in who)) return prepareChangeSet(options, changes, pos, who)
    const nodes = (await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items
    const byId = new Map(nodes.map(node => [node.$id, node])), byPath = new Map(nodes.map(node => [node.$path, node])), index = createChainIndex()
    for (const node of nodes) index.put(node)
    const project = createProjector({ registry, alert: (path, error) => console.error(path, error) })
    const visible = (node: StoredNode) => {
      const ancestors = index.chain(node.$path).filter(ancestor => ancestor.path !== node.$path)
      const rights = computeRights(who.actor, [...ancestors, decodeChainNode(node)], registry)
      const copy = project(node, rights.bits)
      if (copy === null) return null
      if ('node' in copy) return copy.node
      throw copy.error
    }
    const context = overrides.preconditions ?? { index: writer.influence, project: visible,
      work: { used: 0, limit: options.budget?.exprWork ?? 10_000_000 }, domains: () => [store.domain],
      read: async (path: string) => { const node = byPath.get(path); return node === undefined ? null : visible(node) },
      dependency: (input: { readonly kind: string; readonly key: string }) => {
        if (input.kind === 'type') return typeReadVersion(registry, input.key)
        if (input.kind === 'rights') return rightsReadInput(byPath.get(input.key) ?? null, registry)
        if (input.kind === 'actor') return { actor: who.actor, admin: computeRights(who.actor, index.chain('/'), registry).prefix.admin }
        if (input.kind === 'target') return { store: overrides.resolve?.(input.key) ?? store }
        if (input.kind === 'epoch') return writer.stream.cursor().epochs[input.key]
        throw new Error('Unknown read dependency')
      },
    }
    return prepareChangeSet({ ...options, preconditions: context, capabilities: overrides.capabilities ?? {
      node: async id => byId.get(id) ?? null, grants: principal => index.grantsTo(principal),
      ownerGrants: index.grants({ owner: true }), shard: () => false,
    } }, changes, pos, who)
  })
  const nodes = async () => (await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items
  const journal = async () => (await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items
  return { store, cache, registry, writer, commit, nodes, journal }
}
