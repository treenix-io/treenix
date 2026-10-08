import { ancestorPaths, assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { CacheRead } from '#kernel/cache'
import { decodeChainNode } from '#kernel/chain-index'
import type { ExprWork } from '#kernel/eval'
import { createSiftTest } from '#kernel/expr'
import { positionToRev } from '#kernel/position'
import { typeReadVersion, type ReadDependency, type ReadSet } from '#kernel/preconditions'
import { createProjector, visibleNode } from '#kernel/projection'
import { computeRights, type ChainNode } from '#kernel/rights'
import type { AuthReadSource } from '#kernel/session'
import { mapNodeForSift } from '#kernel/store/keys'
import { scanPage } from '#kernel/store/scan'
import { DEFAULT_LIMITS, R, type Budget, type DomainId, type IncludeSpec, type Limits, type Node, type NodeCopy,
  type Path, type ReadResult, type Registry, type Selector, type Sort, type Store, type StoredNode, type SubSelector } from '#kernel/types'
import { getByPath } from '#kernel/update-ops'
import type { Writer } from '#kernel/writer'
import { stableJson } from '#util/stable-json'

export interface ReaderTarget {
  readonly id: string
  readonly store: Store
  chain(path: Path): readonly ChainNode[]
  children(path: Path): Iterable<ChainNode>
}
export interface ReaderSource {
  readonly domains: readonly DomainId[]
  readonly auth: AuthReadSource
  resolve(path: Path): ReaderTarget
}
export interface ReaderOptions {
  readonly registry: Registry
  readonly writer: Pick<Writer, 'cache' | 'stream' | 'read'>
  readonly admission: AuthAdmission
  readonly source: ReaderSource
  readonly budget: Budget
  readonly limits?: Limits
  readonly alert?: (path: Path, error: unknown) => void
}

function ruleTypes(node: ChainNode, registry: Registry): readonly string[] {
  const names = new Set<string>()
  for (const name of node.types) {
    try {
      const type = registry.type(name)
      if (registry.security(name, 'acl') !== undefined) names.add(type.name)
    } catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error
      names.add(name)
    }
  }
  return [...names].sort()
}

export function readerRightsInput(node: ChainNode | undefined, registry: Registry): unknown {
  if (node === undefined) return null
  const rules = ruleTypes(node, registry)
  return { acl: node.hasAcl ? node.acl : undefined, owner: node.hasOwner ? node.owner : undefined,
    rules, invalid: node.invalid, ...(rules.length === 0 ? {} : { id: node.id }) }
}

function path(value: Path): void {
  try { assertSafePath(value) } catch (error) {
    console.error(error)
    throw new KernelError('INVALID', 'Invalid selector path')
  }
}

function includeDepth(include: readonly IncludeSpec[] | undefined, limit: number): void {
  const pending = [...include ?? []].map(spec => ({ spec, depth: 1 }))
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.depth > limit) throw new KernelError('BUDGET', 'Include depth exceeded')
    if ('path' in item.spec) path(item.spec.path)
    else {
      if (item.spec.ref.length === 0) throw new KernelError('INVALID', 'Include needs a reference field')
      for (const spec of item.spec.then ?? []) pending.push({ spec, depth: item.depth + 1 })
    }
  }
}

function reference(node: Node, field: string): Path | undefined {
  const value = getByPath(node, field)
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') { path(value); return value }
  if (typeof value === 'object' && '$ref' in value && typeof value.$ref === 'string') { path(value.$ref); return value.$ref }
  throw new KernelError('INVALID', 'Include field does not contain a reference')
}

interface Loaded { readonly copy: NodeCopy; readonly visible: Node }

export function createReader(options: ReaderOptions) {
  const { registry, writer, admission, source } = options
  const limits = options.limits ?? DEFAULT_LIMITS, allowance = Object.freeze({ ...options.budget })
  const alert = options.alert ?? ((at: Path, error: unknown) => console.error(at, error))
  const projectCopy = createProjector({ registry, alert })
  const work: ExprWork = { used: 0, limit: allowance.exprWork }
  const nodes = new Map<Path, string>(), absent = new Set<Path>()
  const dependencies = new Map<string, ReadDependency>(), selectors: NonNullable<ReadSet['selectors']>[number][] = []
  let scanned = 0, bytes = 0, requestBytes = 0

  function active(): void {
    admission.assertActive()
    if (Date.now() > allowance.deadline) throw new KernelError('BUDGET', 'Read deadline exceeded')
  }
  function depend(input: ReadDependency): void {
    const key = `${input.kind}:${input.key}`
    if (!dependencies.has(key)) dependencies.set(key, input)
  }
  function target(at: Path): ReaderTarget {
    const found = source.resolve(at)
    depend({ kind: 'target', key: at, value: { id: found.id, domain: found.store.domain } })
    return found
  }
  function rights(at: Path, found: ReaderTarget, image?: StoredNode, capture = true) {
    const chain = found.chain(at), inputs = new Map(chain.map(node => [node.path, node]))
    const ancestors = ancestorPaths(at)
    if (image !== undefined) inputs.set(at, decodeChainNode(image))
    if (capture) for (const ancestor of ancestors) {
      if (dependencies.has(`rights:${ancestor}`)) continue
      const node = inputs.get(ancestor)
      depend({ kind: 'rights', key: ancestor, value: readerRightsInput(node, registry) })
      if (node !== undefined) for (const name of ruleTypes(node, registry)) depend({ kind: 'type', key: name, value: typeReadVersion(registry, name) })
    }
    const ordered = ancestors.flatMap(ancestor => {
      const node = inputs.get(ancestor)
      return node === undefined ? [] : [node]
    })
    if (ordered.at(-1)?.path !== at) ordered.push({ path: at, id: '', types: [], acl: [], hasAcl: false, hasOwner: false, alerts: [] })
    const result = computeRights(admission.actor, ordered, registry)
    for (const failure of result.alerts) alert(failure.path, failure.error)
    active()
    return result
  }
  function project(stored: StoredNode, selector: Selector): Node | null {
    const bits = rights(stored.$path, source.resolve(stored.$path), stored, false).bits
    const copy = projectCopy(stored, bits, 'children' in selector ? selector.sort : undefined)
    active()
    return copy === null ? null : 'node' in copy ? copy.node : visibleNode(stored, bits)
  }
  function dependency(input: ReadDependency): unknown {
    if (input.kind === 'actor') return admission.dependency()
    if (input.kind === 'type') return typeReadVersion(registry, input.key)
    if (input.kind === 'epoch') return writer.stream.cursor().epochs[input.key]
    const found = source.resolve(input.key)
    if (input.kind === 'target') return { id: found.id, domain: found.store.domain }
    return readerRightsInput(found.chain(input.key).find(node => node.path === input.key), registry)
  }
  function checkDependencies(): void {
    for (const input of dependencies.values()) if (!isDeepStrictEqual(input.value, dependency(input)))
      throw new KernelError('CONFLICT', 'Read dependencies changed while awaiting data')
  }
  function charge(stored: StoredNode): void {
    active()
    scanned++; bytes += Buffer.byteLength(JSON.stringify(stored))
    if (scanned > allowance.nodes || bytes > allowance.bytes) throw new KernelError('BUDGET', 'Read budget exceeded')
  }
  function remaining(): Budget {
    active()
    if (scanned >= allowance.nodes) throw new KernelError('BUDGET', 'Read node budget exceeded')
    return { ...allowance, nodes: allowance.nodes - scanned, bytes: allowance.bytes - bytes }
  }
  // The caller holds source.domains in an ordered read or commit span.
  async function projectedNode(at: Path): Promise<Node | null> {
    active()
    path(at)
    const found = source.resolve(at), chain = found.chain(at), bits = rights(at, found, undefined, false).bits
    const expected = chain.find(node => node.path === at)
    if (expected === undefined || (bits & R) === 0) return null
    const lease = await writer.cache.fill(found.store, { node: at }, remaining())
    try {
      active()
      const stored = lease.nodes[0]
      if (stored === undefined || stored.$id !== expected.id) throw new KernelError('INVALID', 'Accepted metadata differs from its Store')
      charge(stored)
      const currentBits = rights(at, found, undefined, false).bits
      const copy = projectCopy(stored, currentBits)
      active()
      return copy === null ? null : 'node' in copy ? copy.node : visibleNode(stored, currentBits)
    } finally { lease.release() }
  }

  async function read(input: SubSelector): Promise<ReadResult> {
    active()
    const selector = structuredClone(input)
    requestBytes += Buffer.byteLength(JSON.stringify(selector))
    if (requestBytes > limits.requestBytes) throw new KernelError('BUDGET', 'Read request budget exceeded')
    const root = 'node' in selector ? selector.node : selector.children
    path(root)
    includeDepth(selector.include, limits.includeDepth)
    const sort: Sort = 'children' in selector ? selector.sort ?? [['$order', 1]] : []
    const test = 'children' in selector && selector.where !== undefined ? createSiftTest(selector.where, limits) : undefined
    return writer.read(source.domains, async () => {
      active()
      await admission.validate(source.auth)
      active()
      const cursor = writer.stream.cursor(), at = [cursor.pos]
      depend({ kind: 'actor', key: admission.dependencyKey, value: admission.dependency() })
      for (const domain of source.domains) depend({ kind: 'epoch', key: domain, value: cursor.epochs[domain] })
      selectors.push({ selector, at })
      const loaded = new Map<Path, Loaded | null>(), copies = new Map<string, NodeCopy>(), held: CacheRead[] = []

      async function load(at: Path): Promise<Loaded | null> {
        active()
        if (loaded.has(at)) return loaded.get(at)!
        const found = target(at), chain = found.chain(at), bits = rights(at, found).bits
        const expected = chain.find(node => node.path === at)
        if (expected === undefined || (bits & R) === 0) { loaded.set(at, null); absent.add(at); return null }
        const lease = await writer.cache.fill(found.store, { node: at }, remaining())
        held.push(lease)
        active()
        const stored = lease.nodes[0]
        if (stored === undefined || stored.$id !== expected.id) throw new KernelError('INVALID', 'Accepted metadata differs from its Store')
        charge(stored)
        for (const name of decodeChainNode(stored).types) depend({ kind: 'type', key: name, value: typeReadVersion(registry, name) })
        if (!nodes.has(at)) nodes.set(at, positionToRev(stored.$pos))
        const copy = projectCopy(stored, bits, sort)
        active()
        if (copy === null) { loaded.set(at, null); absent.add(at); return null }
        const value = { copy, visible: 'node' in copy ? copy.node : visibleNode(stored, bits) }
        loaded.set(at, value)
        return value
      }
      async function includes(base: Loaded | undefined, specs: readonly IncludeSpec[]): Promise<void> {
        for (const spec of specs) {
          active()
          const at = 'path' in spec ? spec.path : base === undefined ? undefined : reference(base.visible, spec.ref)
          if (at === undefined) continue
          const value = await load(at)
          if (value === null) continue
          copies.set(value.visible.$id, value.copy)
          if ('ref' in spec && spec.then !== undefined) await includes(value, spec.then)
        }
      }
      try {
        const found = target(root)
        let members: Loaded[], next: string | undefined
        if ('node' in selector) {
          const value = await load(root)
          if (value === null) throw new KernelError('NOT_FOUND', 'Node is absent')
          members = [value]
        } else {
          rights(root, found)
          const candidates: Node[] = []
          for (const child of found.children(root)) {
            const value = await load(child.path)
            if (value !== null && (test === undefined || test(mapNodeForSift(value.visible), work))) candidates.push(value.visible)
          }
          const scope = createHash('sha256').update(stableJson([admission.actor, found.id,
            { ...selector, window: selector.window === undefined ? undefined : { limit: selector.window.limit } }])).digest('hex')
          const page = scanPage(candidates, sort, node => node.$path, scope, selector.window?.after, selector.window?.limit, active)
          next = page.next
          members = page.items.map(node => loaded.get(node.$path)!)
        }
        for (const member of members) copies.set(member.visible.$id, member.copy)
        if (members.length === 0) await includes(undefined, selector.include ?? [])
        for (const member of members) await includes(member, selector.include ?? [])
        active()
        checkDependencies()
        const result = { list: members.map(member => member.visible.$id), copies: [...copies.values()], at, ...(next === undefined ? {} : { next }) }
        active()
        return result
      } finally { for (const lease of held) lease.release() }
    })
  }
  return { read, work, project, projectedNode, dependency, domains: () => source.domains,
    expect(): ReadSet { return { nodes: [...nodes].map(([path, rev]) => ({ path, rev })), absent: [...absent],
      selectors: [...selectors], dependencies: [...dependencies.values()] } } }
}
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
