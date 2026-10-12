import { isDeepStrictEqual } from 'node:util'
import { isRef } from '#core/component'
import { decodeChainNode } from '#kernel/chain-index'
import { KernelError } from '#errors'
import { prepareChangeSet, type ChangeExecutor, type ChangeSetMapping, type ChangeSetOptions, type NodeChange, type NodeRelocation } from '#kernel/changeset'
import type { CacheRead } from '#kernel/cache'
import type { MountEntry } from '#kernel/mounts'
import { combineReadSets } from '#kernel/preconditions'
import { readerOperationCost, type createReader, type ReaderBindingScope, type ReaderLedger, type ReaderSource } from '#kernel/reader'
import type { createStoreBindingOwner } from '#kernel/store-binding'
import { positionToRev } from '#kernel/position'
import { A, R, type ChangeMember, type Node, type OpenedStoreMountTarget, type Path, type Position, type StoreBindingBody, type StoredNode } from '#kernel/types'

export interface StoreChangeBinding {
  readonly entry: MountEntry
  readonly target: OpenedStoreMountTarget
  readonly source: ReturnType<typeof createStoreBindingOwner>
}

export interface StoreChangeMappingOptions {
  readonly source: ReaderSource
  readonly ledger: ReaderLedger
  readonly check: () => void
  readonly binding: (path: Path) => StoreChangeBinding | undefined
  readonly physical: (binding: StoreChangeBinding, scope: ReaderBindingScope) => ReturnType<typeof createReader>
}

/** Maps an admitted logical frame into the owning upper Store under the same Writer decision. */
export function createStoreChangeMapping(owner: StoreChangeMappingOptions, options: ChangeSetOptions,
  original: readonly ChangeMember[], position: Position, executor: ChangeExecutor): ChangeSetMapping {
  const leases: CacheRead[] = []
  const scope: ReaderBindingScope = { span: leases, check: owner.check, hold(lease) { leases.push(lease) } }
  const physical = new Map<StoreChangeBinding['source'], ReturnType<typeof createReader>>()
  const adoptions = new Map<Path, Path>()
  const proofs: ReturnType<ReturnType<typeof createReader>['expect']>[] = []

  function query(binding: StoreChangeBinding) {
    let selected = physical.get(binding.source)
    if (selected === undefined) { selected = owner.physical(binding, scope); physical.set(binding.source, selected) }
    return selected
  }

  function body(node: StoredNode): StoreBindingBody {
    const { $id, $pos, $acl, $owner, ...fields } = node
    return fields
  }

  function before(node: StoredNode | null): Node | null {
    if (node === null) return null
    const { $pos, $acl, $owner, ...fields } = node
    return { ...fields, $rev: positionToRev($pos) }
  }

  function contains(root: Path, path: Path): boolean {
    return path === root || path.startsWith(`${root === '/' ? '' : root}/`)
  }

  async function admitted(path: Path): Promise<StoredNode | null> {
    owner.check()
    const selected = await owner.source.mappedNode?.(path, owner.ledger, scope)
    if (selected === undefined) throw new KernelError('INVALID', 'Logical change has no Store binding owner')
    proofs.push(selected.reads)
    return selected.node
  }

  async function lowerRights(binding: StoreChangeBinding, path: Path): Promise<number> {
    const sources = binding.source.sources(path, binding.source.binding.path)
    const selected = query(binding)
    try { await selected.selectInSpan({ node: sources.lower }) }
    catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'NOT_FOUND') throw error
    }
    return selected.selectedRights(sources.lower)
  }

  function rightsTypes(node: StoredNode | null): Set<string> {
    const result = new Set<string>()
    if (node === null) return result
    for (const type of decodeChainNode(node).types)
      if (options.registry.security(type, 'acl') !== undefined) result.add(options.registry.type(type).name)
    return result
  }

  return {
    adopt(from, to) {
      const binding = owner.binding(from)
      if (binding === undefined) throw new KernelError('INVALID', 'Publication source has no Store binding owner')
      if (from === to || owner.binding(to) !== undefined)
        throw new KernelError('INVALID', 'Publication destination must leave its future namespace')
      adoptions.set(from, to)
    },
    close() { for (const lease of leases.splice(0)) lease.release() },
    async read(range) {
      if (!('node' in range || 'children' in range || 'subtree' in range)) return undefined
      const root = 'node' in range ? range.node : 'children' in range ? range.children : range.subtree
      if (owner.binding(root) === undefined) return undefined
      const nodes: StoredNode[] = []
      const pending = [root]
      while (pending.length !== 0) {
        const path = pending.shift()!
        const node = await admitted(path)
        if (node !== null && (!('children' in range) || path !== root)) nodes.push(node)
        if ('node' in range || 'children' in range && path !== root) continue
        const children = await owner.source.mappedChildren?.(path, owner.ledger, scope)
        if (children === undefined) throw new KernelError('INVALID', 'Logical subtree has no Store binding owner')
        proofs.push(children.reads)
        pending.push(...children.paths)
      }
      return nodes
    },
    async prepare(transitions, remaining) {
      const groups = new Map<StoreChangeBinding['source'], { binding: StoreChangeBinding; changes: NodeChange[] }>()
      for (const transition of transitions) {
        const path = transition.before?.$path ?? transition.after!.$path
        const binding = owner.binding(path)
        if (binding === undefined) continue
        let group = groups.get(binding.source)
        if (group === undefined) { group = { binding, changes: [] }; groups.set(binding.source, group) }
        group.changes.push(transition)
      }
      if (groups.size === 0) return undefined
      const changes: ChangeMember[] = []
      const updates = new Map<Path, Path>()
      const relocations = new Map<Path, NodeRelocation>()
      const recreateBodies = new Map<Path, StoredNode>()
      const outbound = new Map<Path, { binding: StoreChangeBinding; change: NodeChange }>()
      for (const change of original) {
        const path = change.op === 'put' ? change.node.$path : change.op === 'move' || change.op === 'adopt' ? change.from
          : change.op === 'restore' || change.op === 'undo' ? undefined : change.path
        if (path === undefined || owner.binding(path) === undefined) changes.push(change)
      }
      for (const { binding, changes: logical } of groups.values()) {
        const selected = query(binding)
        for (const change of logical) {
          if (change.before !== null || change.after?.$path !== binding.source.binding.path) continue
          const upper = await owner.source.auth.node(binding.source.binding.upper)
          if (upper !== null && binding.source.binding.describe(before(upper)!)?.node === null)
            recreateBodies.set(upper.$path, upper)
        }
        for (const change of logical) {
          if (change.before === null || change.after === null || contains(binding.source.binding.path, change.after.$path)) continue
          if (adoptions.get(change.before.$path) !== change.after.$path)
            throw new KernelError('CROSS_DOMAIN', 'A future move must remain in its namespace')
          const paths = binding.source.sources(change.before.$path, binding.source.binding.path)
          const upper = await owner.source.auth.node(paths.upper)
          let lower = await owner.source.auth.node(paths.lower)
          const selection = binding.source.select({ lower, upper })
          if (selection === null || selection.node === null)
            throw new KernelError('CONFLICT', 'Relocation lost its accepted future source')
          if (selection.baseId !== null && lower?.$id !== selection.baseId)
            lower = await owner.source.auth.nodeById(selection.baseId)
          const physical = selection.baseId === null ? upper : lower
          if (physical === null || binding.source.identity.id(physical.$id) !== change.before.$id)
            throw new KernelError('INVALID', 'Relocation source has another kernel identity')
          const destination = await owner.source.auth.node(change.after.$path)
          if (selection.baseId !== null && (physical.$path !== change.after.$path || destination?.$id !== selection.baseId))
            throw new KernelError('CONFLICT', 'Publication lost its actual lower destination')
          const id = selection.baseId ?? change.before.$id
          relocations.set(change.after.$path, { source: physical, id })
          outbound.set(change.after.$path, { binding, change })
          changes.push({ op: 'put', node: { ...body(change.after),
            ...(destination?.$acl === undefined ? {} : { $acl: destination.$acl }),
            ...(destination?.$owner === undefined ? {} : { $owner: destination.$owner }),
            ...(change.after.$acl === undefined ? {} : { $acl: change.after.$acl }),
            ...(change.after.$owner === undefined ? {} : { $owner: change.after.$owner }) } })
        }
        const futureByPath = new Map(logical.flatMap(change => change.after === null
          || outbound.has(change.after.$path) ? [] : [[change.after.$path, change.after] as const]))
        const existing = new Set(logical.flatMap(change => change.before !== null && change.after !== null
          && change.before.$path === change.after.$path ? [change.after.$path] : []))
        for (const change of logical) {
          const path = change.before?.$path ?? change.after!.$path
          const bits = await lowerRights(binding, path)
          if ((bits & R) === 0) throw new KernelError('FORBIDDEN', 'Future changes require the actual lower read')
          const protectedChange = change.after !== null && (!isDeepStrictEqual(change.before?.$acl, change.after.$acl)
            || change.before?.$owner !== change.after.$owner || !isDeepStrictEqual(rightsTypes(change.before), rightsTypes(change.after)))
          if (protectedChange && (bits & A) === 0)
            throw new KernelError('FORBIDDEN', 'Future protected changes require the actual lower administration')
        }
        const mapped = await binding.source.binding.changes(logical.map(change => ({
          path: change.after !== null && outbound.has(change.after.$path) ? change.before!.$path
            : change.after?.$path ?? change.before!.$path, before: before(change.before),
          after: change.after === null || outbound.has(change.after.$path) ? null : body(change.after),
        })), { read: selector => {
          const path = 'node' in selector ? selector.node : 'children' in selector ? selector.children : selector.history
          if (!contains(binding.source.binding.lower, path) && !contains(binding.source.binding.upper, path))
            throw new KernelError('FORBIDDEN', 'Store mapping read leaves its declared sources')
          return selected.readInSpan(selector)
        } })
        for (const change of mapped) {
          const paths = change.op === 'put' ? [change.node.$path] : change.op === 'move' || change.op === 'adopt' ? [change.from, change.to]
            : change.op === 'restore' || change.op === 'undo' ? [] : [change.path]
          if (paths.length === 0 || paths.some(path => !contains(binding.source.binding.upper, path)))
            throw new KernelError('INVALID', 'Store mapping writes leave its actual upper owner')
          if (change.op === 'put') {
            const suffix = change.node.$path.slice(binding.source.binding.upper === '/' ? 0 : binding.source.binding.upper.length)
            const logicalPath = `${binding.source.binding.path === '/' ? '' : binding.source.binding.path}${suffix}` || '/'
            if (existing.has(logicalPath)) updates.set(change.node.$path, logicalPath)
            const future = futureByPath.get(logicalPath)
            changes.push(future === undefined || future === null ? change : { ...change, node: { ...change.node,
              ...(future.$acl === undefined ? {} : { $acl: future.$acl }),
              ...(future.$owner === undefined ? {} : { $owner: future.$owner }) } })
          } else changes.push(change)
        }
      }
      const published = new Map([...outbound].map(([path, { change }]) =>
        [change.before!.$id, { id: relocations.get(path)!.id, path }] as const))

      async function rewrite(value: unknown, binding: StoreChangeBinding): Promise<void> {
        owner.check()
        readerOperationCost(owner.ledger).charge(0, 0, 1)
        if (value === null || typeof value !== 'object') return
        if (isRef(value)) {
          const accepted = value.$refId === undefined ? undefined : published.get(value.$refId)
          if (accepted !== undefined) {
            value.$refId = accepted.id
            value.$ref = accepted.path
          } else if (value.$refId !== undefined && binding.source.identity.owns(value.$refId)) {
            const id = binding.source.identity.source(value.$refId)
            const physical = await owner.source.auth.nodeById(id)
            const path = binding.source.address(value.$refId, physical?.$path)
            if (path === undefined) throw new KernelError('CONFLICT', 'Publication reference lost its future source')
            const logical = await admitted(path)
            if (logical === null || logical.$id !== value.$refId || physical === null)
              throw new KernelError('CONFLICT', 'Publication reference lost its admitted identity')
            if (!contains(binding.source.binding.lower, physical.$path))
              throw new KernelError('CONFLICT', 'An upper-created reference requires publication in the same decision')
            value.$refId = physical.$id
            value.$ref = physical.$path
          } else if (value.$refId === undefined && contains(binding.source.binding.path, value.$ref)) {
            const destination = adoptions.get(value.$ref)
            if (destination !== undefined) value.$ref = destination
            else {
              const logical = await admitted(value.$ref)
              if (logical === null) throw new KernelError('CONFLICT', 'Publication reference lost its admitted target')
              const accepted = published.get(logical.$id)
              if (accepted !== undefined) value.$ref = accepted.path
              else {
                const physical = await owner.source.auth.nodeById(binding.source.identity.source(logical.$id))
                if (physical === null || !contains(binding.source.binding.lower, physical.$path))
                  throw new KernelError('CONFLICT', 'An upper-created reference requires publication in the same decision')
                value.$ref = physical.$path
              }
            }
          }
        }
        for (const child of Object.values(value)) await rewrite(child, binding)
      }

      for (let index = 0; index < changes.length; index++) {
        const change = changes[index]
        if (change.op !== 'put') continue
        const publication = outbound.get(change.node.$path)
        if (publication === undefined) continue
        const node = structuredClone(change.node)
        readerOperationCost(owner.ledger).charge(0, Buffer.byteLength(JSON.stringify(node)))
        await rewrite(node, publication.binding)
        changes[index] = { op: 'put', node }
      }
      owner.check()
      const reads = combineReadSets([...proofs, ...[...physical.values()].map(reader => reader.expect()), executor.expect ?? {}])
      const bindings = [...groups.values()].map(group => group.binding).sort((left, right) =>
        right.source.binding.upper.length - left.source.binding.upper.length)
      /** Keep logical proofs projected when a root-based future also contains their paths. */
      function proofReader(path: Path) {
        if (owner.binding(path) !== undefined) return undefined
        for (const { binding } of groups.values()) {
          if (contains(binding.source.binding.lower, path) || contains(binding.source.binding.upper, path))
            return query(binding)
        }
        return undefined
      }
      const preconditions = options.preconditions === undefined ? undefined : { ...options.preconditions,
        read: (path: Path) => proofReader(path)?.projectedNode(path) ?? options.preconditions!.read(path),
        project: (node: StoredNode, selector: Parameters<NonNullable<ChangeSetOptions['preconditions']>['project']>[1]) => {
          const selected = proofReader(node.$path)
          return selected === undefined ? options.preconditions!.project(node, selector) : selected.project(node, selector)
        } }
      const prepared = await prepareChangeSet({ ...options, mapping: undefined, budget: remaining, preconditions,
        readCost: readerOperationCost(owner.ledger), actionChanges: transitions, relocations, recreateBodies,
        // Updating existing future data allocates a delta record, without widening the logical write mask.
        creationScopePath: path => updates.get(path),
        scopePath(path) {
          for (const binding of bindings) if (contains(binding.source.binding.upper, path)) {
            const suffix = path.slice(binding.source.binding.upper === '/' ? 0 : binding.source.binding.upper.length)
            // A binding's private header records the already-authorized logical frame.
            if (suffix === '') {
              const change = groups.get(binding.source)!.changes[0]
              return change.before?.$path ?? change.after!.$path
            }
            return `${binding.source.binding.path === '/' ? '' : binding.source.binding.path}${suffix}` || '/'
          }
          return options.scopePath?.(path) ?? path
        } }, changes, position,
        { ...executor, expect: reads })
      const staged = new Map(prepared.writes.map(write => [write.path, write.node]))
      for (const { binding } of groups.values()) {
        const path = binding.source.binding.upper
        if (!recreateBodies.has(path)) continue
        const current = staged.get(path)
        const selected = current === undefined || current === null ? null : binding.source.binding.describe(before(current)!)
        if (selected === null || selected.node === null || selected.source !== 'upper' || selected.baseId !== null)
          throw new KernelError('INVALID', 'Recreated root lacks its attested upper body')
      }
      for (const { binding, change } of outbound.values()) {
        const path = binding.source.sources(change.before!.$path, binding.source.binding.path).upper
        if (!staged.has(path)) throw new KernelError('INVALID', 'Publication did not mutate its actual upper source')
        const upper = staged.get(path)!
        if (upper !== null && binding.source.binding.describe(before(upper)!)?.node !== null)
          throw new KernelError('INVALID', 'Publication retained a readable future source')
      }
      const logicalWrites: NonNullable<typeof prepared.logicalWrites>[number][] = []
      for (const { binding, changes: logical } of groups.values()) for (const change of logical) {
        if (change.before !== null && (change.after === null || change.before.$path !== change.after.$path))
          logicalWrites.push({ path: change.before.$path, node: null })
        if (change.after === null) continue
        if (outbound.has(change.after.$path)) {
          const node = staged.get(change.after.$path)
          if (node === undefined || node === null || node.$id !== relocations.get(change.after.$path)?.id)
            throw new KernelError('INVALID', 'Mapped relocation lost its accepted destination')
          logicalWrites.push({ path: change.after.$path, node })
          continue
        }
        const paths = binding.source.sources(change.after.$path, binding.source.binding.path)
        const upper = staged.has(paths.upper) ? staged.get(paths.upper)! : await owner.source.auth.node(paths.upper)
        let lower = await owner.source.auth.node(paths.lower)
        const selection = binding.source.select({ lower, upper })
        if (selection?.baseId !== null && selection?.baseId !== undefined && lower?.$id !== selection.baseId) {
          lower = await owner.source.auth.nodeById(selection.baseId)
          if (lower === null || !contains(binding.source.binding.lower, lower.$path))
            throw new KernelError('CONFLICT', 'Staged future lost its actual lower source')
        }
        const node = binding.source.projectStaged(change.after.$path, { lower, upper })
        if (node === null || change.before !== null && node.$id !== change.before.$id)
          throw new KernelError('INVALID', 'Store mapping lost the accepted logical identity')
        logicalWrites.push({ path: change.after.$path, node })
      }
      return { ...prepared, logicalWrites, budget: readerOperationCost(owner.ledger).budget() }
    },
  }
}
