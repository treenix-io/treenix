import { KernelError } from '#errors'
import { createActionControl } from '#kernel/action-context'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { ReadSet } from '#kernel/preconditions'
import type { LaneDeliveryImage, LaneProjection, LaneSelection, LaneRoot } from '#kernel/lane-selection'
import { compareScanKeys, scanKey, type ScanKey } from '#kernel/store/scan'
import { serializeKernel } from '#kernel/serialization'
import { revToPosition } from '#kernel/position'
import type { OperationReadCost } from '#kernel/store/budget'
import type { FederationClient } from '#kernel/authority/owner'
import type { createAuthorityNamespace } from '#kernel/authority/namespace'
import type { Bits, LaneOwnership, NodeCopy, Path, ReadResult, ScanRange, SubSelector } from '#kernel/types'

interface ForeignRoot extends LaneRoot {
  readonly member: NonNullable<LaneRoot['member']>
}
interface ForeignSelection extends LaneSelection<LaneDeliveryImage> {
  readonly roots: readonly ForeignRoot[]
}

interface ForeignSubscriptionOptions {
  readonly selector: SubSelector
  readonly admission: AuthAdmission
  readonly handle: FederationClient
  readonly namespace: ReturnType<typeof createAuthorityNamespace>
  readonly reads: ReadSet
  readonly authorize: () => Bits
  readonly changed: () => void
  readonly project: (value: ReadResult, cost: OperationReadCost) => ReadResult
  readonly queryFields: readonly string[]
}

/** Native delivery retains mapped projected copies while the remote lane owns their canonical coverage. */
export function createForeignSubscription(options: ForeignSubscriptionOptions): LaneProjection {
  const { handle, namespace, selector } = options
  let closed = false, ready = false, failure: unknown, version = 0
  let selection: ForeignSelection | undefined
  const cursors = new Map<Path, { readonly key: ScanKey; readonly value: string }>()
  function changed(): void { if (!closed) { version++; options.changed() } }
  const delegated = 'children' in selector ? { children: selector.children, include: selector.include, queryFields: options.queryFields } : selector
  const remote = handle.client.sub(namespace.selector(delegated), changed, error => { failure = error; changed() })
  void remote.ready.then(() => { ready = true; changed() }, error => { if (!closed) { failure = error; changed() } })
  function check(): void {
    if (closed) throw new KernelError('CANCELLED', 'Foreign subscription is closed')
    if (failure !== undefined) throw failure
    options.authorize()
    handle.active()
  }
  async function validate(cost: OperationReadCost): Promise<void> {
    const control = createActionControl(options.admission, cost.budget().deadline)
    try {
      await control.wait(handle.check())
      check()
      if (!ready) return
      const list = handle.client.cache.list(remote.id)
      if (list === undefined || list.phase !== 'ready') { selection = undefined; return }
      if (list.at === undefined) throw new KernelError('INVALID', 'Foreign subscription positions are absent')
      cost.charge(0, 0, list.ids.length + list.covered.length + (list.computed?.length ?? 0) + (list.viewErrors?.length ?? 0))
      let owned = list.ownership
      if (owned === undefined) {
        if (!('node' in selector) || (selector.include?.length ?? 0) !== 0 ||
          list.covered.length !== list.ids.length || list.ids.some(id => !list.covered.includes(id)))
          throw new KernelError('UNAVAILABLE', 'Foreign coverage ownership is unavailable')
        owned = { fixed: [], roots: list.ids.map(id => ({ id, covered: [id], cursor: id })) }
      }
      let metadata = owned.roots.length + owned.fixed.length
      for (const root of owned.roots) { cost.charge(0, 0, 1); metadata += root.covered.length }
      cost.charge(0, 0, metadata)
      for (const id of owned.fixed) cost.charge(0, 0, Math.ceil(id.length / 8))
      for (const root of owned.roots) {
        cost.charge(0, 0, Math.ceil(root.id.length / 8) + Math.ceil(root.cursor.length / 8))
        for (const id of root.covered) cost.charge(0, 0, Math.ceil(id.length / 8))
      }
      const rootIds = new Set(owned.roots.map(root => root.id))
      const expected = new Set([...owned.fixed, ...owned.roots.flatMap(root => root.covered)])
      if (rootIds.size !== owned.roots.length || rootIds.size !== list.ids.length || list.ids.some(id => !rootIds.has(id)) ||
        expected.size !== list.covered.length || list.covered.some(id => !expected.has(id)))
        throw new KernelError('INVALID', 'Foreign coverage ownership differs from its delivered members')
      if (list.covered.length > cost.budget().nodes) throw new KernelError('BUDGET', 'Foreign coverage exceeds the node budget')
      const computed = new Set(list.computed?.map(node => node.$id)), errors = new Set(list.viewErrors?.map(copy => copy.id))
      const copies: NodeCopy[] = []
      for (const id of list.covered) {
        if (computed.has(id) || errors.has(id)) continue
        const copy = handle.client.cache.copy(id)
        if (copy === undefined) throw new KernelError('INVALID', 'Foreign covered copy is absent')
        copies.push(copy)
      }
      const at = list.at.map(pos => {
        const current = handle.client.cache.watermark(pos.instance)
        if (current === undefined) throw new KernelError('INVALID', 'Foreign subscription watermark is absent')
        return current
      })
      const input: ReadResult = { list: list.ids, copies, at, computed: list.computed, viewErrors: list.viewErrors,
        rows: list.rows, next: list.next, viewOwner: list.viewOwner }
      const mapped = namespace.result(input, options.authorize(), cost.budget(), (nodes, work) => cost.charge(nodes, 0, work))
      const mappedOwnership = namespace.ownership(owned, options.authorize(), cost.budget(), work => cost.charge(0, 0, work))
      const value = options.project({ ...mapped, ownership: mappedOwnership }, cost)
      const ownership = value.ownership
      if (ownership === undefined) throw new KernelError('INVALID', 'Projected foreign ownership is absent')
      cost.charge(0, Buffer.byteLength(serializeKernel(value)) + Buffer.byteLength(serializeKernel(ownership)))
      const images = new Map<string, LaneDeliveryImage>()
      const positions = new Map(value.at.map(pos => [pos.instance, pos]))
      for (const copy of value.copies) {
        const id = 'node' in copy ? copy.node.$id : copy.id
        const position = 'node' in copy ? positions.get(revToPosition(copy.node.$rev).instance) : undefined
        images.set(id, { copy, bytes: Buffer.byteLength(serializeKernel(copy)), position, retain: () => () => {} })
      }
      const nodes = new Map(value.computed?.map(node => [node.$id, node]))
      const errorCopies = new Map(value.viewErrors?.map(copy => [copy.id, copy]))
      function branch(ids: readonly string[]) {
        const covered: string[] = [], computed: string[] = [], viewErrors: string[] = []
        for (const id of ids) {
          if (nodes.has(id)) computed.push(id)
          else if (errorCopies.has(id)) viewErrors.push(id)
          else covered.push(id)
        }
        return { covered, computed, viewErrors, reads: options.reads }
      }
      const sort = 'children' in selector ? selector.sort ?? [['$order', 1] as const] : []
      cursors.clear()
      const roots = ownership.roots.map(root => {
        const image = images.get(root.id), computed = nodes.get(root.id), error = errorCopies.get(root.id)
        const copy = image?.copy ?? error
        const path = computed?.$path ?? (copy === undefined ? undefined : 'node' in copy ? copy.node.$path : copy.path)
        if (path === undefined) throw new KernelError('INVALID', 'Foreign direct member has no projected payload')
        const key = computed !== undefined ? scanKey(computed, sort, path) : copy !== undefined && 'node' in copy
          ? scanKey(copy.node, sort, path) : root.query !== undefined ? scanKey(root.query, sort, path)
            : scanKey(copy?.sort ?? {}, sort, path, (fields, field) => Reflect.get(fields, field))
        cursors.set(path, { key, value: root.cursor })
        return { path, member: { id: root.id, key, query: root.query }, ...branch(root.covered) }
      })
      roots.sort((a, b) => compareScanKeys(a.member.key, b.member.key, sort))
      selection = { roots, fixedIncludes: branch(ownership.fixed),
        images: [...images.values()], reads: options.reads, computed: value.computed, viewErrors: value.viewErrors,
        rows: value.rows, next: value.next, at: value.at, viewOwner: value.viewOwner }
      check()
    } finally { control.close() }
  }
  function intersects(test: (range: ScanRange) => boolean): boolean {
    return test('node' in selector ? { node: selector.node } : { children: selector.children }) ||
      (options.reads.nodes?.some(node => test({ node: node.path })) ?? false)
  }
  return { key: remote.id, get version() { return version }, get ready() { return failure !== undefined || ready },
    authority: { validate, check, image(path) { return selection?.images.find(image => ('node' in image.copy ? image.copy.node.$path : image.copy.path) === path) ?? null } },
    intersects, invalidate: changed,
    cursor(key) {
      check()
      const current = cursors.get(key.key)
      const sort = 'children' in selector ? selector.sort ?? [['$order', 1] as const] : []
      if (current === undefined || compareScanKeys(key, current.key, sort) !== 0)
        throw new KernelError('INVALID', 'Foreign cursor has no exact delivered owner')
      return current.value
    },
    select(range) {
      check()
      if (selection === undefined) return undefined
      const upper = range?.upper
      const sort = 'children' in selector ? selector.sort ?? [['$order', 1] as const] : []
      const matching = selection.roots.filter(root => upper !== null && (upper === undefined || compareScanKeys(root.member.key, upper, sort) <= 0))
      const limit = range === undefined && 'children' in selector ? selector.window?.limit : undefined
      const roots = limit === undefined ? matching : matching.slice(0, limit)
      const covered = new Set<string>()
      for (const branch of [selection.fixedIncludes, ...roots]) {
        for (const id of branch.covered) covered.add(id)
        for (const id of branch.computed ?? []) covered.add(id)
        for (const id of branch.viewErrors ?? []) covered.add(id)
      }
      return { ...selection, roots, next: roots.length < matching.length && roots.length !== 0 ? cursors.get(roots[roots.length - 1].path)!.value : undefined,
        images: selection.images.filter(image => covered.has('node' in image.copy ? image.copy.node.$id : image.copy.id)),
        computed: selection.computed?.filter(node => covered.has(node.$id)), viewErrors: selection.viewErrors?.filter(copy => covered.has(copy.id)) }
    },
    close() { closed = true; selection = undefined; cursors.clear(); remote.close() },
  }
}
