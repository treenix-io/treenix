import { isDeepStrictEqual } from 'node:util'
import { ancestorPaths, assertSafePath, dirname } from '#core/path'
import { KernelError } from '#errors'
import { guardAction, type ActionProvenance } from '#kernel/action-guard'
import { guardCapabilities, type CapabilityState } from '#kernel/capability'
import { decodeChainNode } from '#kernel/chain-index'
import type { NodeChange } from '#kernel/changeset'
import { computeRights, type ChainNode, type RightsAlert, type RightsResult } from '#kernel/rights'
import { assertNodeSchema } from '#kernel/schema'
import { A, W, type Actor, type JournalEntry, type Preconditions, type Registry, type StoredNode } from '#kernel/types'

export type GuardExecutor = Actor | 'kernel' | `external:${string}`
export interface GuardOptions {
  readonly registry: Registry
  readonly executor: GuardExecutor
  readonly readBefore: (path: string) => Promise<StoredNode | null>
  readonly alert?: (alert: RightsAlert) => void
  readonly capabilities?: CapabilityState
  readonly expect?: Preconditions
  readonly action?: ActionProvenance
}

export function createGuard({ registry, executor, readBefore, capabilities, expect, action, alert = value => console.error(value.error) }: GuardOptions) {
  const permissions = new Map<string, Promise<RightsResult>>()
  const actor = typeof executor === 'string' ? undefined : executor
  async function rights(path: string): Promise<RightsResult> {
    if (actor === undefined) throw new KernelError('INVALID', 'An internal executor has no ACL subject')
    const previous = permissions.get(path)
    if (previous !== undefined) return previous
    const pending = (async () => {
      const chain: ChainNode[] = []
      for (const at of ancestorPaths(path)) {
        const node = await readBefore(at)
        if (node !== null) chain.push(decodeChainNode(node))
      }
      if (chain.at(-1)?.path !== path) chain.push({ path, id: '', types: [], acl: [], hasAcl: false, hasOwner: false, alerts: [] })
      const result = computeRights(actor, chain, registry)
      for (const failure of result.alerts) alert(failure)
      return result
    })()
    permissions.set(path, pending)
    return pending
  }
  async function require(path: string, bit: number): Promise<void> {
    if (((await rights(path)).bits & bit) === 0) throw new KernelError('FORBIDDEN', 'ChangeSet lacks the required rights')
  }
  function ruleTypes(node: StoredNode): Set<string> {
    const types = new Set<string>()
    for (const name of decodeChainNode(node).types) if (registry.security(name, 'acl') !== undefined) types.add(registry.type(name).name)
    return types
  }
  function invariants(before: StoredNode | null, after: StoredNode | null): void {
    if (after === null) return
    assertSafePath(after.$path)
    if (typeof after.$id !== 'string' || after.$id.length === 0 || typeof after.$type !== 'string' || after.$type.length === 0
      || after.$id.startsWith('p:') && after.$id !== `p:${after.$path}`) throw new KernelError('INVALID', 'Invalid stored identity')
    if (before !== null && (before.$id !== after.$id || before.$type !== after.$type
      && registry.type(before.$type).name !== registry.type(after.$type).name)) throw new KernelError('INVALID', 'Node identity and type are immutable')
  }

  return {
    async finish(changes: readonly NodeChange[]): Promise<void> {
      if (actor === undefined) return
      if (capabilities === undefined) throw new KernelError('INVALID', 'The original capability index is required')
      const admin = (await rights('/')).prefix.admin
      await guardCapabilities(changes, { registry, state: capabilities, readBefore, expect,
        requireA: path => require(path, A), admin })
      await guardAction(changes, { registry, source: action, admin, readBefore })
    },
    async put(before: StoredNode | null, after: StoredNode): Promise<StoredNode> {
      if (actor === undefined || before === null || ((await rights(before.$path)).bits & A) !== 0) return after
      for (const field of ['$acl', '$owner']) {
        if (after[field] !== undefined && !isDeepStrictEqual(after[field], before[field])) throw new KernelError('FORBIDDEN', 'Hidden metadata cannot be changed')
        Reflect.deleteProperty(after, field)
        if (Object.hasOwn(before, field)) Object.defineProperty(after, field, { value: before[field], enumerable: true, writable: true, configurable: true })
      }
      return after
    },
    async history(entry: JournalEntry, images: readonly (StoredNode | null | 'unknown')[]): Promise<void> {
      if (actor === undefined) return
      for (const path of new Set([entry.path, ...entry.from === undefined ? [] : [entry.from]])) {
        const current = await rights(path)
        if ((current.bits & A) === 0) throw new KernelError('NOT_FOUND', 'Journal record is absent')
        for (const image of images) {
          if (image === 'unknown') throw new KernelError('NOT_FOUND', 'Journal record is absent')
          if (image === null) continue
          const node = decodeChainNode(image)
          const historical = computeRights(actor, [{ ...node, path, acl: [], hasAcl: false, hasOwner: false, owner: undefined }], registry, current.prefix)
          for (const failure of historical.alerts) alert(failure)
          if ((historical.bits & A) === 0) throw new KernelError('NOT_FOUND', 'Journal record is absent')
        }
      }
    },
    async transition(before: StoredNode | null, after: StoredNode | null): Promise<void> {
      invariants(before, after)
      if (typeof executor === 'string' && executor.startsWith('external:')) return
      if (actor !== undefined) {
        if (before !== null) await require(before.$path, W)
        if (after !== null && (before === null || before.$path !== after.$path)) {
          const parent = dirname(after.$path) ?? '/'
          await require(parent, W)
          if (after.$acl !== undefined || after.$owner !== undefined) await require(parent, A)
        }
        if (before !== null && after !== null && (!isDeepStrictEqual(before.$acl, after.$acl)
          || before.$owner !== after.$owner || !isDeepStrictEqual(ruleTypes(before), ruleTypes(after)))) await require(before.$path, A)
      }
      if (after !== null) {
        if (decodeChainNode(after).invalid !== undefined) throw new KernelError('INVALID', 'Invalid rights metadata')
        assertNodeSchema(after, registry)
      }
    },
  }
}
