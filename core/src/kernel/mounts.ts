import { AsyncLocalStorage } from 'node:async_hooks'

import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import { componentEntries } from '#kernel/migrate'
import { ownMountTarget } from '#kernel/mount-resource'
import type {
  Budget, Component, ComponentName, MountDecl, MountHandler, Node, NodeId, OpenedMountTarget,
  NodeMeta, Path, Registry, Rev, ScanRange, Session, TypeDef, TypeName,
} from '#kernel/types'
import { stableJson } from '#util/stable-json'

export interface MountDeclaration {
  readonly node: Node
  readonly component: ComponentName
  readonly declaration: MountDecl
}

export interface MountChange {
  readonly id: NodeId
  readonly declarations: readonly MountDeclaration[]
}

export interface MountRange {
  readonly key: string
  readonly generation: string
  readonly base: Path
  readonly pattern: string
  readonly state: 'idle' | 'opening' | 'active' | 'unavailable'
  contains(path: Path): boolean
  intersects(range: ScanRange): boolean
  start(path: Path): Path | undefined
}

export interface MountEntry extends MountDeclaration {
  readonly key: string
  readonly revision: Rev
  readonly range: MountRange
}

export interface MountResolution {
  readonly entry: MountEntry
  readonly target: OpenedMountTarget
  readonly start: Path
}

export interface MountSession {
  readonly session: Session
  close(): void
}

export interface MountTableOptions {
  readonly registry: Registry
  /** Configured owners publish after bootstrap; their accepted claims must already block parent routing. */
  readonly declarationTypes?: ReadonlySet<TypeName>
  readonly openSession: (node: Node) => Promise<MountSession>
  readonly activate: (entry: MountEntry, target: OpenedMountTarget) => Promise<void>
  /** Ordered Writer retirement owns release of a registered target. */
  readonly retire: (entry: MountEntry, target: OpenedMountTarget) => Promise<void>
  readonly changed: (before: readonly MountRange[], after: readonly MountRange[]) => void
  readonly failed: (error: unknown) => void
}

export interface MountStage {
  readonly ranges: readonly MountRange[]
}

interface Pattern {
  readonly segments: readonly Segment[]
  readonly descendantsOnly: boolean
}

interface Entry extends MountEntry {
  readonly pattern: Pattern
  readonly type: TypeDef | undefined
  readonly handler: MountHandler | undefined
  state: MountRange['state']
  opening?: Promise<void>
  session?: MountSession
  target?: OpenedMountTarget
  registered: boolean
  retired: boolean
  cleanupError?: unknown
}

interface StageState {
  readonly version: number
  readonly entries: Map<string, Entry>
}

interface OpeningWaiter {
  resolve(): void
  reject(reason: unknown): void
}

const wildcard = Symbol('mount-segment')
type Segment = string | typeof wildcard

interface RangeAddress {
  readonly kind: 'node' | 'children' | 'subtree'
  readonly parts: readonly string[]
}

/** Split one queried address once before walking the declaration inventory. */
function partsOf(path: Path): readonly string[] {
  return path === '/' ? [] : path.slice(1).split('/')
}

/** Compare finite segment templates without constructing descendant or ancestor strings. */
function compatible(a: readonly Segment[], b: readonly Segment[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== wildcard && b[i] !== wildcard && a[i] !== b[i]) return false
  }
  return true
}

/** Match a target root and its descendants without allocating an ancestor chain. */
function contains(pattern: Pattern, parts: readonly string[]): boolean {
  return parts.length >= pattern.segments.length && compatible(parts, pattern.segments)
    && (!pattern.descendantsOnly || parts.length > pattern.segments.length)
}

/** Normalize a scan once while preserving its direct-child versus subtree semantics. */
function addressOf(range: ScanRange): RangeAddress {
  if ('node' in range) return { kind: 'node', parts: partsOf(range.node) }
  if ('children' in range) return { kind: 'children', parts: partsOf(range.children) }
  return { kind: 'subtree', parts: partsOf(range.subtree) }
}

/** Decide potential intersection of a scan and a finite mount template. */
function intersects(pattern: Pattern, range: RangeAddress): boolean {
  if (range.kind === 'node') return contains(pattern, range.parts)
  if (!compatible(range.parts, pattern.segments)) return false
  if (range.kind === 'subtree') return true
  return range.parts.length + 1 >= pattern.segments.length + (pattern.descendantsOnly ? 1 : 0)
}

/** Compile a relative template; a star matches exactly one nonempty path segment. */
function compile(base: Path, pattern: string): Pattern {
  try {
    assertSafePath(base)
    if (pattern.startsWith('/')) throw new Error('A mount pattern must be relative')
    if (pattern !== '') assertSafePath(`/${pattern}`)
  } catch (error) {
    throw new KernelError('INVALID', error instanceof Error ? error.message : 'Invalid relative mount pattern')
  }

  const relative = pattern === '' ? [] : pattern.split('/')
  if (relative.some(segment => segment.includes('*') && segment !== '*')) {
    throw new KernelError('INVALID', 'A mount wildcard must occupy one path segment')
  }
  const prefix = base === '/' ? [] : base.slice(1).split('/')
  return { segments: [...prefix, ...relative.map(segment => segment === '*' ? wildcard : segment)], descendantsOnly: pattern === '' }
}

/** Decode settings at the stored mount boundary rather than silently ignoring malformed declarations. */
function declaration(component: Component): MountDecl {
  if (typeof component.pattern !== 'string'
    || component.external !== undefined && component.external !== 'none' && component.external !== 'trusted') {
    throw new KernelError('INVALID', 'Malformed mount declaration')
  }
  const { pattern, external, ...fields } = component
  return { ...fields, pattern, ...(external === undefined ? {} : { external }) }
}

/** Retain only mounting settings and identity metadata, leaving unrelated bodies in the shared cache. */
function snapshot(input: MountDeclaration): MountDeclaration {
  const source = input.node
  const metadata: NodeMeta = {
    $path: source.$path, $id: source.$id, $rev: source.$rev, $type: source.$type,
    ...(source.$order === undefined ? {} : { $order: source.$order }),
    ...(source.$v === undefined ? {} : { $v: source.$v }),
    ...(source.$acl === undefined ? {} : { $acl: structuredClone(source.$acl) }),
    ...(source.$owner === undefined ? {} : { $owner: source.$owner }),
  }
  const settings = structuredClone(input.declaration)
  const node: Node = input.component === '' ? { ...settings, ...metadata }
    : { ...metadata, [input.component]: settings }
  return { node, component: input.component, declaration: settings }
}

/** Owns accepted claims independently of the asynchronously opened and fenced target resources. */
export function createMountTable(options: MountTableOptions) {
  let entries = new Map<string, Entry>()
  let keysByNode = new Map<NodeId, readonly string[]>()
  let acceptedRanges: readonly MountRange[] = []
  const stages = new WeakMap<MountStage, StageState>()
  const retiring = new Set<Promise<void>>()
  const openingContext = new AsyncLocalStorage<readonly string[]>()
  const waits = new WeakMap<Promise<void>, Set<OpeningWaiter>>()
  let version = 0, generation = 0
  let closed = false
  let failure: { readonly error: unknown } | undefined
  let closing: Promise<void> | undefined

  /** Reject operations after shutdown or a failed ordered resource transition. */
  function available(): void {
    if (failure !== undefined) throw failure.error
    if (closed) throw new KernelError('UNAVAILABLE', 'Mount table is closed')
  }

  /** Keep exact owner semantics pinned while an opening or accepted operation is pending. */
  function current(entry: Entry): boolean {
    if (entries.get(entry.key) !== entry || entry.retired) return false
    try {
      return options.registry.type(entry.declaration.$type) === entry.type
        && options.registry.security(entry.declaration.$type, 'mount') === entry.handler
    } catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error
      return false
    }
  }

  /** Build one immutable routing template and one owned declaration snapshot. */
  function entryOf(input: MountDeclaration): Entry {
    const owned = snapshot(input)
    const key = stableJson([owned.node.$id, owned.component])
    const pattern = compile(owned.node.$path, owned.declaration.pattern)
    let type: TypeDef | undefined
    try { type = options.registry.type(owned.declaration.$type) }
    catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error
    }
    const handler = options.registry.security(owned.declaration.$type, 'mount')
    const identity = `${key}:${++generation}`

    /** Return the concrete match root, with the declaring node kept in its parent Store. */
    function start(path: Path): Path | undefined {
      const parts = partsOf(path)
      if (!contains(pattern, parts)) return undefined
      return pattern.segments.length === 0 ? '/' : `/${parts.slice(0, pattern.segments.length).join('/')}`
    }

    /** Test whether a scan can address any claimed node without enumerating wildcard matches. */
    function intersectsRange(range: ScanRange): boolean {
      return intersects(pattern, addressOf(range))
    }

    const range: MountRange = {
      key, generation: identity, base: owned.node.$path, pattern: owned.declaration.pattern,
      get state() { return current(entry) ? entry.state : 'unavailable' },
      contains: path => contains(pattern, partsOf(path)), intersects: intersectsRange, start,
    }
    const entry: Entry = { ...owned, key, revision: owned.node.$rev, range, pattern, type, handler,
      state: handler === undefined ? 'unavailable' : 'idle', registered: false, retired: false }
    return entry
  }

  /** Report background retirement failures immediately and retain them for awaiting callers. */
  function retire(entry: Entry): void {
    if (entry.retired) return
    entry.retired = true
    const work = (async () => {
      try {
        // The opening caller receives its own failure; retirement only owns the resource cleanup.
        if (entry.opening !== undefined) await Promise.allSettled([entry.opening])
        if (entry.cleanupError !== undefined) throw entry.cleanupError
        if (entry.registered && entry.target !== undefined) await options.retire(entry, entry.target)
      } finally {
        entry.session?.close()
      }
    })()
    retiring.add(work)
    void work.then(() => retiring.delete(work), error => {
      retiring.delete(work)
      failure = { error }
      options.failed(error)
    })
  }

  /** Recheck staged topology immediately before accepting its declaring-node commit. */
  function validateStage(stage: MountStage): void {
    available()
    const staged = stages.get(stage)
    if (staged === undefined || staged.version !== version) {
      throw new KernelError('CONFLICT', 'Mount topology changed during declaration preparation')
    }
  }

  /** Prepare replacements atomically; none of their claims is visible until publication. */
  function stage(changes: readonly MountChange[]): MountStage {
    available()
    const updated = new Map<string, Entry>()
    const removed = new Set<string>()
    const changed = new Set<NodeId>()
    for (const change of changes) {
      if (changed.has(change.id)) throw new KernelError('INVALID', 'Duplicate mount node change')
      changed.add(change.id)
      const replacements = new Set<string>()
      for (const input of change.declarations) {
        if (input.node.$id !== change.id) throw new KernelError('INVALID', 'Mount declaration belongs to another node')
        const key = stableJson([change.id, input.component])
        if (replacements.has(key)) throw new KernelError('INVALID', 'Duplicate mount component')
        replacements.add(key)
        const previous = entries.get(key)
        if (previous === undefined || previous.node.$path !== input.node.$path
          || stableJson(previous.declaration) !== stableJson(input.declaration)) updated.set(key, entryOf(input))
      }
      for (const key of keysByNode.get(change.id) ?? []) if (!replacements.has(key)) removed.add(key)
    }

    const next = updated.size === 0 && removed.size === 0 ? entries : new Map(entries)
    for (const key of removed) next.delete(key)
    for (const [key, entry] of updated) next.set(key, entry)
    for (const entry of updated.values()) for (const other of next.values()) {
      if (entry !== other && compatible(entry.pattern.segments, other.pattern.segments)) {
        throw new KernelError('INVALID', 'Overlapping mount declarations')
      }
    }
    const staged = Object.freeze({ ranges: next === entries ? acceptedRanges
      : Object.freeze([...next.values()].map(entry => entry.range)) })
    stages.set(staged, { version, entries: next })
    return staged
  }

  /** Publish accepted claims before observers see the declaring-node record. */
  function publish(stage: MountStage): void {
    validateStage(stage)
    const staged = stages.get(stage)!
    if (staged.entries === entries) return
    const before = [...entries.values()]
    entries = staged.entries
    acceptedRanges = stage.ranges
    const nextKeys = new Map<NodeId, string[]>()
    for (const entry of entries.values()) {
      let keys = nextKeys.get(entry.node.$id)
      if (keys === undefined) { keys = []; nextKeys.set(entry.node.$id, keys) }
      keys.push(entry.key)
    }
    keysByNode = nextKeys
    version++
    for (const entry of before) if (entries.get(entry.key) !== entry) retire(entry)
    options.changed(before.map(entry => entry.range), [...entries.values()].map(entry => entry.range))
  }

  /** Require the same accepted declaration and owner handler inside the Writer lifecycle span. */
  function validate(key: string, revision: Rev): void {
    available()
    const entry = entries.get(key)
    if (entry === undefined || entry.revision !== revision || !current(entry)
      || entry.handler === undefined || entry.type?.security === 'ordinary') {
      throw new KernelError('CONFLICT', 'Mount declaration or owner handler changed')
    }
  }

  /** Make routing visible in the synchronous accepted Writer publication, never a later microtask. */
  function activated(key: string, revision: Rev, target: OpenedMountTarget): void {
    validate(key, revision)
    const entry = entries.get(key)!
    if (entry.target !== target) throw new KernelError('INVALID', 'Activation uses another opened target')
    entry.registered = true
    entry.state = 'active'
  }

  /** Open and activate once; independent callers share this Promise and owner Session. */
  function open(entry: Entry): Promise<void> {
    if (openingContext.getStore()?.includes(entry.key)) {
      return Promise.reject(new KernelError('UNAVAILABLE', 'A mount cannot read its own unopened target'))
    }
    if (entry.opening !== undefined) return entry.opening
    if (entry.state === 'active' && current(entry)) return Promise.resolve()
    if (!current(entry) || entry.handler === undefined || entry.type?.security === 'ordinary') {
      return Promise.reject(new KernelError('UNAVAILABLE', 'Mount owner handler is unavailable'))
    }
    const handler = entry.handler
    entry.state = 'opening'
    const work = openingContext.run([...(openingContext.getStore() ?? []), entry.key], async () => {
      try {
        entry.session = await options.openSession(entry.node)
        validate(entry.key, entry.revision)
        if (entry.session.session.actor.principal !== `n:${entry.node.$id}`) {
          throw new KernelError('INVALID', 'Mount handler requires its declaring node session')
        }
        entry.target = ownMountTarget(await handler(entry.node, entry.session.session))
        validate(entry.key, entry.revision)
        if (entry.target.kind === 'store' && entry.declaration.external === 'trusted'
          && entry.target.store.external === undefined) {
          throw new KernelError('INVALID', 'Trusted mount Store must report external edits')
        }
        if (entry.target.kind === 'view' && entry.target.executor === 'node'
          && entry.target.sources !== undefined && entry.type?.security !== 'privileged-capability') {
          throw new KernelError('FORBIDDEN', 'View sources require a privileged mount owner')
        }
        await options.activate(entry, entry.target)
        if (!entry.registered) throw new KernelError('INVALID', 'Mount activation did not publish its registration')
      } catch (error) {
        try {
          if (!entry.registered) await entry.target?.close()
        } catch (cleanup) {
          entry.cleanupError = cleanup
          const fatal = new AggregateError([error, cleanup], 'Mount opening and cleanup failed')
          failure = { error: fatal }
          options.failed(fatal)
          throw fatal
        } finally {
          entry.session?.close()
          entry.session = undefined
          if (!entry.registered && entry.cleanupError === undefined) entry.target = undefined
        }
        entry.state = 'idle'
        throw error
      }
    })
    entry.opening = work
    void work.then(() => { entry.opening = undefined }, () => { entry.opening = undefined })
    return work
  }

  /** Check cancellation and wall time independently of payload accounting. */
  function check(budget: Budget, signal?: AbortSignal): void {
    available()
    if (signal?.aborted) throw cancellation(signal)
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Mount preparation deadline exceeded')
  }

  /** Preserve native admission failures and normalize external AbortController reasons. */
  function cancellation(signal: AbortSignal): KernelError {
    return signal.reason instanceof KernelError
      ? signal.reason
      : new KernelError('CANCELLED', 'Mount preparation cancelled')
  }

  /** Keep one Promise dispatcher so detached callers are not retained by a stalled opener. */
  function openingWaiters(work: Promise<void>): Set<OpeningWaiter> {
    const existing = waits.get(work)
    if (existing !== undefined) return existing
    const waiters = new Set<OpeningWaiter>()
    waits.set(work, waiters)
    work.then(() => {
      waits.delete(work)
      for (const waiter of waiters) waiter.resolve()
    }, reason => {
      waits.delete(work)
      for (const waiter of waiters) waiter.reject(reason)
    })
    return waiters
  }

  /** Detach one cancelled or expired caller while the declaration keeps its shared target opening. */
  function waitOpening(work: Promise<void>, budget: Budget, signal?: AbortSignal): Promise<void> {
    const waiters = openingWaiters(work)
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let aborted: (() => void) | undefined
      /** Remove every per-caller resource on the first settlement. */
      function cleanup(): boolean {
        if (settled) return false
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (signal !== undefined && aborted !== undefined) signal.removeEventListener('abort', aborted)
        waiters.delete(waiter)
        return true
      }
      const waiter: OpeningWaiter = {
        resolve() { if (cleanup()) resolve() },
        reject(reason) { if (cleanup()) reject(reason) },
      }
      waiters.add(waiter)
      timer = setTimeout(() => waiter.reject(new KernelError('BUDGET', 'Mount opening deadline exceeded')),
        Math.max(1, budget.deadline - Date.now() + 1))
      if (signal !== undefined) {
        aborted = () => waiter.reject(cancellation(signal))
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      }
    })
  }

  /** Reuse active targets and bind pending openings to this caller's lifetime. */
  async function prepareEntry(entry: Entry, budget: Budget, signal?: AbortSignal): Promise<void> {
    check(budget, signal)
    if (entry.state !== 'active' || !current(entry))
      await waitOpening(open(entry), budget, signal)
    check(budget, signal)
  }

  /** Open intersecting targets before any Reader barrier that their handlers may themselves need. */
  async function prepareRanges(ranges: readonly ScanRange[], budget: Budget, signal?: AbortSignal): Promise<void> {
    check(budget, signal)
    const addresses = ranges.map(addressOf)
    for (const entry of entries.values()) {
      check(budget, signal)
      if (addresses.some(range => intersects(entry.pattern, range))) {
        await prepareEntry(entry, budget, signal)
      }
    }
  }

  return {
    stage, validateStage, publish, validate, activated, prepareRanges,
    /** Adopt only exact accepted declarations during startup, without inventing wildcard addresses. */
    async prepareKeys(keys: readonly string[], budget: Budget, signal?: AbortSignal): Promise<void> {
      check(budget, signal)
      const selected = keys.map(key => {
        const entry = entries.get(key)
        if (entry === undefined) throw new KernelError('UNAVAILABLE', 'Mount declaration is unavailable')
        return entry
      })
      for (const entry of selected) await prepareEntry(entry, budget, signal)
    },
    /** Rebind accepted declarations after owner publication without relinquishing their claimed ranges. */
    registryChanged(): void {
      available()
      const before = [...entries.values()]
      const next = new Map(entries)
      for (const entry of before) if (!current(entry)) next.set(entry.key, entryOf(entry))
      if (before.every(entry => next.get(entry.key) === entry)) return
      entries = next
      acceptedRanges = Object.freeze([...entries.values()].map(entry => entry.range))
      version++
      for (const entry of before) if (entries.get(entry.key) !== entry) retire(entry)
      options.changed(before.map(entry => entry.range), [...entries.values()].map(entry => entry.range))
    },
    /** Extract all owner-handler declarations, retaining explicit invalid mount claims loudly. */
    declarationsOf(node: Node): MountChange {
      const declarations: MountDeclaration[] = []
      for (const [component, value] of componentEntries(node)) {
        if (component !== '#mount' && !options.declarationTypes?.has(value.$type)
          && options.registry.security(value.$type, 'mount') === undefined) continue
        declarations.push({ node, component, declaration: declaration(value) })
      }
      return { id: node.$id, declarations }
    },
    /** Prepare direct addresses using the same range-aware opening path. */
    prepare(paths: readonly Path[], budget: Budget, signal?: AbortSignal): Promise<void> {
      return prepareRanges(paths.map(node => ({ node })), budget, signal)
    },
    /** Resolve only active claims; a claimed but unavailable address never falls back to its parent. */
    resolve(path: Path): MountResolution | undefined {
      available()
      const parts = partsOf(path)
      for (const entry of entries.values()) {
        if (!contains(entry.pattern, parts)) continue
        if (!current(entry) || entry.state !== 'active' || entry.target === undefined) {
          throw new KernelError('UNAVAILABLE', 'Mount target is not available')
        }
        const start = entry.pattern.segments.length === 0 ? '/'
          : `/${parts.slice(0, entry.pattern.segments.length).join('/')}`
        return { entry, target: entry.target, start }
      }
      return undefined
    },
    /** Expose routing claims even while their target has not opened or has become invalid. */
    ranges(range?: ScanRange): readonly MountRange[] {
      if (range === undefined) return acceptedRanges
      const address = addressOf(range)
      return [...entries.values()].flatMap(entry => intersects(entry.pattern, address) ? [entry.range] : [])
    },
    /** Pin semantic topology, including unavailable claims, for Reader and subscription dependencies. */
    topology(range: ScanRange): string {
      const address = addressOf(range)
      return stableJson([...entries.values()].flatMap(entry => intersects(entry.pattern, address)
        ? [[entry.key, entry.range.generation, entry.range.state]] : []))
    },
    /** Detect concrete match roots without enumerating the subtree behind a declaration. */
    boundary(path: Path): boolean {
      const parts = partsOf(path)
      for (const entry of entries.values()) {
        if (parts.length === entry.pattern.segments.length && compatible(parts, entry.pattern.segments)) return true
      }
      return false
    },
    /** Await owned openings and retirements; registered Store cleanup belongs to Writer.closeTargets. */
    close(): Promise<void> {
      if (closing !== undefined) return closing
      closed = true
      for (const entry of entries.values()) entry.session?.close()
      closing = (async () => {
        const work = [...retiring]
        const openings = [...entries.values()].flatMap(entry => entry.opening === undefined ? [] : [entry.opening])
        await Promise.allSettled(openings)
        for (const entry of entries.values()) if (entry.cleanupError !== undefined) work.push(Promise.reject(entry.cleanupError))
        const results = await Promise.allSettled(work)
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failure !== undefined) errors.push(failure.error)
        if (errors.length !== 0) throw new AggregateError(errors, 'Mount resources failed to close')
      })()
      return closing
    },
  }
}

export type MountTable = ReturnType<typeof createMountTable>
