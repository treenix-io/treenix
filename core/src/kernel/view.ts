import { serializeKernel } from '#kernel/serialization'
import { ancestorPaths, isChildPath } from '#core/path'
import { KernelError } from '#errors'
import { createActionControl } from '#kernel/action-context'
import type { AuthAdmission } from '#kernel/auth-factory'
import { createSiftTest } from '#kernel/expr'
import { assertIncludeDepth, followIncludes } from '#kernel/include'
import { stableJson } from '#util/stable-json'
import { getByPath } from '#kernel/update-ops'
import { createHash } from 'node:crypto'
import type { NodeLaneImage } from '#kernel/lane'
import type { LaneRange, LaneSelection } from '#kernel/lane-selection'
import type { ReadDependency } from '#kernel/preconditions'
import { createReaderLedger, type ReaderLedger } from '#kernel/reader'
import { comparePositions } from '#kernel/position'
import { mapNodeForSift } from '#kernel/store/keys'
import { compareScanKeys, scanCursor, scanKey, scanPage, type ScanKey } from '#kernel/store/scan'
import type { Budget, ComputedNode, DeriveHandler, DeriveRequest, DerivedResult, DomainId, Limits, Node, Path,
  ReadResult, ScanRange, Selector, StreamEvent, SubSelector } from '#kernel/types'

export interface ViewSubscription {
  readonly key: string
  readonly version: number
  readonly ready: boolean
  intersects(test: (range: ScanRange) => boolean): boolean
  invalidate(): void
  cursor(key: ScanKey): string
  select(range?: LaneRange): LaneSelection | undefined
  close(): void
}
export interface ViewRead {
  (selector: Selector, observe: (input: ReadDependency) => void, ledger: ReaderLedger, check: () => void): Promise<LaneSelection & {
    readonly at: ReadResult['at']; readonly history?: ReadResult['history']
  }>
}
export interface ViewOptions {
  readonly node: Node
  readonly admission: AuthAdmission
  readonly derive: DeriveHandler
  readonly executor: 'reader' | 'node'
  readonly sources?: readonly Path[]
  readonly limits: () => Limits
  readonly budget: () => Budget
  readonly position: () => ReadResult['at'][number]
  readonly read: ViewRead
  readonly observe: (listener: (event: StreamEvent) => void) => () => void
  readonly topologyChanged: (listener: (test: (range: ScanRange) => boolean) => void) => () => void
  readonly domainIntersects: (domain: DomainId, range: ScanRange) => boolean
  readonly active?: () => void
}
interface Result {
  readonly value: DerivedResult
  readonly images: ReadonlyMap<Path, NodeLaneImage>
  readonly release: readonly (() => void)[]
  readonly reads: LaneSelection['reads']
  readonly at: ReadResult['at']
  readonly computed?: ReadonlyMap<Path, ComputedNode>
  readonly includes: ReadonlyMap<string, ViewIncludes>
}
interface ViewIncludes { readonly fixed: readonly Path[]; readonly roots: ReadonlyMap<Path, readonly Path[]> }

/** Own one executor's dependency routes and serialize its runs without holding a Writer barrier. */
export function createView(options: ViewOptions) {
  const listeners = new Set<() => void>()
  const selectors = new Map<() => void, SubSelector>()
  let dependencies: ScanRange[] = []
  let provisional: ScanRange[] | undefined
  let result: Result | undefined
  let failure: unknown
  let running = false
  let dirty = true
  let closed = false
  let started = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: DeriveRequest = {}
  let version = 0
  let generation = 0
  const controls = new Set<ReturnType<typeof createActionControl>>()

  /** Wake subscribers after the visible result or failure changes. */
  function notify(): void { for (const listener of listeners) listener() }

  /** Match a path against one reader dependency range. */
  function intersects(range: ScanRange, path: Path): boolean {
    if ('node' in range) return range.node === path
    if ('children' in range) return isChildPath(range.children, path)
    return path === range.subtree || path.startsWith(`${range.subtree === '/' ? '' : range.subtree}/`)
  }

  /** Check whether a changed path can affect this executor's current run. */
  function affected(path: Path): boolean {
    return [...dependencies, ...provisional ?? [], ...options.sources?.map(subtree => ({ subtree })) ?? []]
      .some(range => intersects(range, path))
  }

  /** Include active selectors and fixed sources when checking invalidation. */
  function intersectsDependencies(test: (range: ScanRange) => boolean): boolean {
    return [{ node: options.node.$path }, ...dependencies, ...provisional ?? [],
      ...[...selectors.values()].map(selector => 'node' in selector ? { node: selector.node } : { children: selector.children }),
      ...options.sources?.map(subtree => ({ subtree })) ?? []].some(test)
  }

  /** Discard stale output and queue a replacement run. */
  function invalidate(): void {
    generation++
    failure = undefined
    for (const drop of result?.release ?? []) drop()
    result = undefined
    dirty = true
    schedule()
    notify()
  }

  const stopTopology = options.topologyChanged(test => {
    if (intersectsDependencies(test)) invalidate()
  })
  const stop = options.observe(event => {
    if (event.t === 'reset') {
      if (intersectsDependencies(range => options.domainIntersects(event.domain, range))) invalidate()
    } else if (event.t === 'gap') invalidate()
    else if (event.record.entries.some(entry =>
      affected(entry.path) || entry.from !== undefined && affected(entry.from))) {
      dirty = true
      schedule()
    }
  })

  /** Serialize recomputation and enforce the configured interval. */
  function schedule(): void {
    if (closed || running || timer !== undefined || !dirty || listeners.size === 0) return
    const delay = options.limits().recomputeIntervalMs - (performance.now() - started)
    if (delay > 0) {
      timer = setTimeout(() => { timer = undefined; schedule() }, delay)
      return
    }
    running = true
    dirty = false
    started = performance.now()
    void run().then(() => { running = false; schedule() }, error => {
      console.error(error)
      failure = error
      running = false
      notify()
      schedule()
    })
  }

  /** Run derivation, collect dependencies, and publish one complete result. */
  async function run(): Promise<void> {
    const gen = generation
    const ranges: ScanRange[] = []
    provisional = ranges
    const images = new Map<Path, NodeLaneImage>()
    const computed = options.executor === 'node' ? new Map<Path, ComputedNode>() : undefined
    const release: (() => void)[] = []
    const reads: LaneSelection['reads'][] = []
    let at: ReadResult['at'] = [options.position()]
    const ledger = createReaderLedger(options.budget(), options.limits())
    const control = createActionControl(options.admission, ledger.budget.deadline, () => {
      if (closed) throw new KernelError('CANCELLED', 'View executor has ended')
      options.active?.()
    })
    controls.add(control)

    /** Record the reader dependencies needed to invalidate this run. */
    function observe(input: ReadDependency): void {
      if (input.kind === 'topology') ranges.push(input.range)
      else if (input.kind === 'target' || input.kind === 'rights') ranges.push({ node: input.key })
    }

    try {
      /** Read through the owning Reader and retain the selected images. */
      async function read(selector: Selector): Promise<ReadResult> {
        control.active()
        const path = 'node' in selector ? selector.node : 'children' in selector ? selector.children : selector.history
        ranges.push('node' in selector ? { node: path } : 'children' in selector ? { children: path } : { subtree: path })
        for (const ancestor of ancestorPaths(path)) ranges.push({ node: ancestor })
        const selection = await control.wait(options.read(selector, observe, ledger, control.active))
        reads.push(selection.reads)
        for (const image of selection.images) {
          const path = 'node' in image.copy ? image.copy.node.$path : image.copy.path
          if (options.executor === 'node') {
            // Subscriber predicates and references see the same declassified fields as computed output.
            const { $acl, $owner, ...visible } = image.visible
            images.set(path, { ...image, visible })
            if ('node' in image.copy) computed!.set(path, visible)
          } else images.set(path, image)
          release.push(image.retain())
        }
        for (const position of selection.at) {
          const prior = at.find(previous => previous.instance === position.instance)
          if (prior === undefined) at = [...at, position]
          else if (comparePositions(prior, position) < 0)
            at = at.map(previous => previous === prior ? position : previous)
        }
        return { list: selection.roots.flatMap(root => root.member === undefined ? [] : [root.member.id]),
          copies: selection.images.map(image => image.copy), at: selection.at, next: selection.next, history: selection.history }
      }

      control.active()
      const value = await control.wait(options.derive(options.node, request, { read }))
      for (const member of value.members)
        if (!images.has(member)) throw new KernelError('INVALID', 'View member was not read through its Reader')

      const includes = new Map<string, ViewIncludes>()
      /** Resolve an include target through the same reader as the derived members. */
      async function included(path: Path) {
        if (!images.has(path)) {
          try { await read({ node: path }) }
          catch (error) {
            if (error instanceof KernelError && error.code === 'NOT_FOUND') return null
            throw error
          }
        }
        const image = images.get(path)
        if (image === undefined) throw new KernelError('INVALID', 'Include read returned no image')
        return { visible: image.visible }
      }
      for (const selector of selectors.values()) {
        const key = stableJson(selector.include ?? [])
        if (includes.has(key)) continue
        const fixed = new Set<Path>()
        const roots = new Map<Path, readonly Path[]>()
        const fixedSpecs = selector.include?.flatMap(spec => 'path' in spec ? [spec] : []) ?? []
        const refs = selector.include?.flatMap(spec => 'ref' in spec ? [spec] : []) ?? []
        await followIncludes(undefined, fixedSpecs, included, value => fixed.add(value.visible.$path), control.active)
        for (const path of value.members) {
          const base = await included(path)
          if (base === null) throw new KernelError('INVALID', 'A read View member disappeared from its run')
          const covered = new Set<Path>()
          await followIncludes(base, refs, included, value => covered.add(value.visible.$path), control.active)
          roots.set(path, [...covered])
        }
        includes.set(key, { fixed: [...fixed], roots })
      }
      const bytes = Buffer.byteLength(JSON.stringify(value.rows ?? [])) + [...images.values()]
        .reduce((total, image) => total + image.bytes, 0)

      if (bytes > options.limits().readBytes) throw new KernelError('BUDGET', 'View result exceeds its byte allowance')
      if (ledger.failure !== undefined) throw ledger.failure
      if (Date.now() > ledger.budget.deadline) throw new KernelError('BUDGET', 'View run exceeded its deadline')
      if (closed || gen !== generation) { for (const drop of release) drop(); return }
      const previous = result
      result = { value: { ...value, rows: value.rows === undefined && previous?.value.rows !== undefined ? [] : value.rows },
        images, release, at, computed, includes, reads: {
        nodes: reads.flatMap(read => read.nodes ?? []), absent: reads.flatMap(read => read.absent ?? []),
        selectors: reads.flatMap(read => read.selectors ?? []), dependencies: reads.flatMap(read => read.dependencies ?? []),
      } }
      dependencies = ranges
      failure = undefined
      version++
      provisional = undefined
      notify()
      for (const drop of previous?.release ?? []) drop()
    } catch (error) {
      for (const drop of release) drop()
      provisional = undefined
      if (gen !== generation) return
      dependencies = ranges
      throw error
    } finally { controls.delete(control); control.close() }
  }

  return {
    subscribe(selector: SubSelector, changed: () => void): ViewSubscription {
      assertIncludeDepth(selector.include, options.limits().includeDepth)
      const includeKey = stableJson(selector.include ?? [])
      const scope = createHash('sha256').update(stableJson([options.admission.actor, options.node.$id, options.node.$rev,
        { ...selector, ...('children' in selector ? { window: selector.window === undefined ? undefined : { limit: selector.window.limit } } : {}) }])).digest('hex')
      if (options.executor === 'reader') request = 'children' in selector
        ? { where: selector.where, sort: selector.sort, window: selector.window } : {}
      listeners.add(changed)
      selectors.set(changed, selector)
      if (result !== undefined && !result.includes.has(includeKey)) dirty = true
      schedule()
      return {
        key: options.executor === 'node' ? options.node.$id : crypto.randomUUID(),
        get version() { return version },
        get ready() { return failure !== undefined || result?.includes.has(includeKey) === true },
        cursor(key) { return scanCursor(scope, key) },
        intersects: intersectsDependencies,
        invalidate,
        select(range) {
          if (failure !== undefined) throw failure
          if (result === undefined || !result.includes.has(includeKey)) return undefined
          const sort = 'children' in selector ? selector.sort ?? [['$order', 1]] : []
          const predicate = 'children' in selector && selector.where !== undefined
            ? createSiftTest(selector.where, options.limits()) : undefined
          const work = { used: 0, limit: options.limits().exprWork }
          const candidates = result.value.members.map(path => result!.images.get(path)!)
          const eligible = candidates.filter(image => {
            return (predicate === undefined || predicate(mapNodeForSift(image.visible), work))
              && (range?.upper === undefined || range.upper !== null
                && compareScanKeys(scanKey(image.visible, sort, image.visible.$path), range.upper, sort) <= 0)
          })
          const nodes = eligible.map(image => image.visible)
          const window = 'children' in selector ? selector.window : undefined
          const page = scanPage(nodes, sort, node => node.$path, scope,
            range === undefined ? window?.after : undefined, range === undefined ? window?.limit : undefined, () => {})
          const selected = new Set(page.items.map(node => node.$path))
          const includes = result.includes.get(includeKey)!
          for (const path of includes.fixed) selected.add(path)
          for (const node of page.items) for (const path of includes.roots.get(node.$path)!) selected.add(path)
          const selectedImages = [...selected].map(path => {
            const image = result!.images.get(path)!
            if ('node' in image.copy) return image
            const values = Object.fromEntries(sort.map(([field]) => [field, structuredClone(getByPath(image.visible, field))]))
            const copy = { ...image.copy, sort: values,
              ver: createHash('sha256').update(stableJson([image.copy.ver, values])).digest('hex') }
            return { ...image, copy, bytes: Buffer.byteLength(serializeKernel(copy)) }
          })
          const computed = result.computed === undefined ? undefined
            : [...selected].flatMap(path => {
              const node = result!.computed!.get(path)
              return node === undefined ? [] : [node]
            })
          function ids(paths: readonly Path[]): string[] {
            return paths.map(path => {
              const copy = result!.images.get(path)!.copy
              return 'node' in copy ? copy.node.$id : copy.id
            })
          }
          function baseIds(paths: readonly Path[]): string[] {
            return computed === undefined ? ids(paths.filter(path => 'node' in result!.images.get(path)!.copy)) : []
          }
          function computedIds(paths: readonly Path[]): string[] | undefined {
            return computed === undefined ? undefined : ids(paths.filter(path => result!.computed!.has(path)))
          }
          function errorIds(paths: readonly Path[]): string[] {
            return ids(paths.filter(path => 'error' in result!.images.get(path)!.copy))
          }
          return {
            roots: page.items.map(node => ({ path: node.$path, member: { id: node.$id, key: scanKey(node, sort, node.$path) },
              covered: baseIds([node.$path, ...includes.roots.get(node.$path)!]),
              computed: computedIds([node.$path, ...includes.roots.get(node.$path)!]),
              viewErrors: errorIds([node.$path, ...includes.roots.get(node.$path)!]), reads: {} })),
            fixedIncludes: { covered: baseIds(includes.fixed), computed: computedIds(includes.fixed),
              viewErrors: errorIds(includes.fixed), reads: result.reads },
            images: computed === undefined ? selectedImages.filter(image => 'node' in image.copy) : [],
            viewErrors: selectedImages.flatMap(image => 'error' in image.copy ? [image.copy] : []),
            reads: result.reads, computed, rows: result.value.rows, next: page.next, at: result.at,
          }
        },
        close() {
          listeners.delete(changed)
          selectors.delete(changed)
          if (listeners.size === 0) {
            generation++
            failure = undefined
            if (timer !== undefined) { clearTimeout(timer); timer = undefined }
            for (const control of controls) control.close()
            for (const drop of result?.release ?? []) drop()
            result = undefined
            dirty = true
          }
        },
      }
    },
    close() {
      closed = true
      generation++
      if (timer !== undefined) clearTimeout(timer)
      stop()
      stopTopology()
      for (const control of controls) control.close()
      listeners.clear()
      selectors.clear()
      for (const drop of result?.release ?? []) drop()
    },
  }
}
