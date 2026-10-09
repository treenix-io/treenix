import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import { stableJson } from '#util/stable-json'
import type { OpenedSession, SessionFactory } from '#kernel/session-factory'
import type { Limits, Node, NodeId, Path, Registry, ServiceHandler, ServiceRun, Store } from '#kernel/types'

export interface ServiceTarget {
  readonly node: Node
  readonly handler: ServiceHandler
  readonly store: Store
  readonly generation: string
  readonly registryType: ReturnType<Registry['type']>
}

export interface ServiceBootstrapPorts {
  readonly openNode: SessionFactory['openNode']
  readonly captureOwn: (opened: OpenedSession, path: Path, expected?: Node) => Promise<ServiceTarget>
  readonly validateOwn: (opened: OpenedSession, target: ServiceTarget) => Promise<void>
  readonly observeNode: (node: Node, invalidated: () => void) => () => void
  readonly addressById: (id: NodeId) => Promise<Path | undefined>
  readonly bootstrapPath: () => Promise<Path | undefined>
  readonly observeBootstrap: (changed: () => void) => () => void
  readonly limits: () => Limits
}

interface RequestedService {
  readonly path: Path
  readonly expected?: Node
  readonly declarations?: readonly Node[]
  readonly validate?: () => Promise<void>
}

interface SelectedService extends RequestedService {
  readonly declarations: Node[]
}

interface OwnedService {
  readonly requested: RequestedService
  readonly control: AbortController
  opened?: OpenedSession
  target?: ServiceTarget
  run?: ServiceRun
  remove?: () => void
  stop?: Promise<void>
  release?: Promise<void>
  failure?: { readonly error: unknown }
  cleanupFailure?: { readonly error: unknown }
  invalidated?: boolean
  stopping: boolean
}

/** Compare accepted configuration independently of its journal position. */
export function serviceConfiguration(node: Node): string {
  const { $rev, $acl, $owner, ...configuration } = node
  return stableJson(configuration)
}

/** Own actual node sessions and handle cleanup without retaining past registrations. */
function createServiceOwner(ports: ServiceBootstrapPorts, capture: () => Promise<readonly RequestedService[]>) {
  const owned = new Map<Path, OwnedService>()
  const cleanup = new Set<Promise<void>>()
  let closed = false
  let requested = false
  let work: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const control = new AbortController()
  let endedReject = (_error: unknown) => {}
  const ended = new Promise<never>((_resolve, reject) => { endedReject = reject })
  void ended.catch(() => {})

  /** Report each registration's primary failure once. */
  function report(record: OwnedService, error: unknown): void {
    if (record.failure?.error === error || record.cleanupFailure?.error === error) return
    console.error(error)
    if (record.failure === undefined) record.failure = { error }
    else if (record.cleanupFailure === undefined) record.cleanupFailure = { error }
  }

  /** Release a real handle once, including one returned after its startup ended. */
  function release(record: OwnedService, run: ServiceRun): Promise<void> {
    if (record.release !== undefined) return record.release
    const pending = (async () => {
      try {
        await run.stop()
        await run.done
      } catch (error) {
        if (!(record.stopping && record.opened?.admission.signal.aborted && error instanceof KernelError
          && (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED'))) throw error
      }
    })()
    record.release = pending
    cleanup.add(pending)
    void pending.then(() => cleanup.delete(pending), error => {
      cleanup.delete(pending)
      report(record, error)
    })
    return pending
  }

  /** End admission synchronously before waiting for the handler's cleanup. */
  function stop(record: OwnedService): Promise<void> {
    if (record.stop !== undefined) return record.stop
    record.stopping = true
    record.remove?.()
    record.remove = undefined
    record.control.abort(new KernelError('CANCELLED', 'Service registration ended'))
    record.opened?.session.close()
    return record.stop = record.run === undefined ? Promise.resolve() : release(record, record.run)
  }

  /** Bound acquisition and startup, observing late resources without awaiting a stalled handler. */
  async function start(request: RequestedService): Promise<void> {
    const record: OwnedService = { requested: request, control: new AbortController(), stopping: false }
    owned.set(request.path, record)
    const signal = record.control.signal
    let abort = () => {}
    const ended = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    void ended.catch(() => {})
    const timer = setTimeout(() => {
      record.control.abort(new KernelError('BUDGET', 'Service startup exceeded its budget'))
      record.opened?.session.close()
    }, ports.limits().actionMs)
    const removals: (() => void)[] = []
    const invalidated = () => {
      record.invalidated = true
      void stop(record).then(() => {
        if (!closed) void reconcile().catch(reportReconciliation)
      }, error => report(record, error))
    }
    record.remove = () => { for (const remove of removals) remove() }
    for (const declaration of request.declarations ?? [])
      removals.push(ports.observeNode(declaration, invalidated))
    try {
      const opening = ports.openNode(request.path, { heartbeat: false })
      void opening.then(opened => {
        if (signal.aborted || closed) opened.session.close()
      }, () => {})
      const opened = await Promise.race([opening, ended])
      record.opened = opened
      signal.throwIfAborted()
      const admissionEnded = () => { void stop(record).catch(error => report(record, error)) }
      opened.admission.signal.addEventListener('abort', admissionEnded, { once: true })
      removals.push(() => opened.admission.signal.removeEventListener('abort', admissionEnded))
      opened.admission.assertActive()
      const target = await Promise.race([ports.captureOwn(opened, request.path, request.expected), ended])
      record.target = target
      signal.throwIfAborted()
      opened.admission.assertActive()
      if (!(request.declarations ?? []).some(declaration => declaration.$id === target.node.$id))
        removals.push(ports.observeNode(target.node, invalidated))
      if (request.validate !== undefined) await Promise.race([request.validate(), ended])
      signal.throwIfAborted()
      opened.admission.assertActive()
      await Promise.race([ports.validateOwn(opened, target), ended])
      signal.throwIfAborted()
      opened.admission.assertActive()
      const starting = target.handler(target.node, opened.session)
      void starting.then(run => {
        void run.done?.catch(() => {})
        if (record.stopping || closed) void release(record, run).catch(error => report(record, error))
      }, () => {})
      record.run = await Promise.race([starting, ended])
      signal.throwIfAborted()
      opened.admission.assertActive()
      await Promise.race([ports.validateOwn(opened, target), ended])
      opened.admission.assertActive()
      if (record.run.done !== undefined) {
        void record.run.done.then(() => {
          if (!record.stopping) {
            report(record, new KernelError('UNAVAILABLE', 'Service background work ended'))
            void stop(record).catch(error => report(record, error))
          }
        }, error => {
          if (!record.stopping) report(record, error)
          void stop(record).catch(cleanupError => report(record, cleanupError))
        })
      }
    } catch (error) {
      if (!record.stopping) report(record, error)
      await stop(record)
      if (!closed && record.failure !== undefined) throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  /** Coalesce accepted changes into one authorized reconciliation task. */
  function reconcile(): Promise<void> {
    if (closed) return Promise.reject(control.signal.reason)
    requested = true
    if (work !== undefined) return work
    return work = (async () => {
      while (requested && !closed) {
        requested = false
        const desired = await Promise.race([capture(), ended])
        if (desired.length > ports.limits().maxLanes)
          throw new KernelError('BUDGET', 'Service registration limit exceeded')
        const next = new Map(desired.map(request => [request.path, request]))
        for (const [path, record] of owned) {
          const request = next.get(path)
          if (request === undefined || record.invalidated || record.stopping && record.failure === undefined
            || request.expected !== undefined && record.target !== undefined
            && (serviceConfiguration(request.expected) !== serviceConfiguration(record.target.node)
              || record.failure !== undefined && request.expected.$rev !== record.target.node.$rev)) {
            await stop(record)
            owned.delete(path)
          }
        }
        for (const request of desired) {
          if (closed) break
          if (!owned.has(request.path)) await start(request)
          const record = owned.get(request.path)
          if (record?.failure !== undefined) throw record.failure.error
        }
      }
    })().catch(error => {
      control.signal.throwIfAborted()
      throw error
    }).finally(() => { work = undefined })
  }

  /** Observe reconciliation failures while preserving expected owned shutdown. */
  function reportReconciliation(error: unknown): void {
    if (error === control.signal.reason) return
    for (const record of owned.values())
      if (record.failure?.error === error || record.cleanupFailure?.error === error) return
    console.error(error)
  }

  /** Refuse new starts and drain the currently owned resources. */
  function close(): Promise<void> {
    if (closing !== undefined) return closing
    closed = true
    control.abort(new KernelError('CANCELLED', 'Service owner is closed'))
    endedReject(control.signal.reason)
    for (const record of owned.values()) void stop(record).catch(error => report(record, error))
    return closing = (async () => {
      const errors: unknown[] = []
      try { await work } catch (error) { if (error !== control.signal.reason) errors.push(error) }
      for (const record of owned.values()) {
        try { await stop(record) } catch (error) { if (!errors.includes(error)) errors.push(error) }
        if (record.failure !== undefined && !errors.includes(record.failure.error)) errors.push(record.failure.error)
        if (record.cleanupFailure !== undefined && !errors.includes(record.cleanupFailure.error)) errors.push(record.cleanupFailure.error)
      }
      const settled = await Promise.allSettled(cleanup)
      for (const result of settled) if (result.status === 'rejected' && !errors.includes(result.reason)) errors.push(result.reason)
      owned.clear()
      if (errors.length > 0) throw new AggregateError(errors, 'Service cleanup failed')
    })()
  }

  /** A changed bootstrap registration can supersede its current failed start. */
  function invalidate(): void {
    for (const record of owned.values()) {
      if (record.failure === undefined) continue
      record.invalidated = true
      void stop(record).catch(error => report(record, error))
    }
  }

  return { reconcile, invalidate, close, reportReconciliation }
}

/** Activate the fixed bootstrap service after mounts and native ownership are ready. */
export function createInstanceServices(ports: ServiceBootstrapPorts) {
  const owner = createServiceOwner(ports, async () => {
    const path = await ports.bootstrapPath()
    return path === undefined ? [] : [{ path }]
  })
  const remove = ports.observeBootstrap(() => {
    owner.invalidate()
    void owner.reconcile().catch(owner.reportReconciliation)
  })
  return {
    ready: owner.reconcile,
    async close() { remove(); await owner.close() },
  }
}

/** The bootstrap handler is the single consumer of its discovery lane. */
export function createAutostartHandler(ports: ServiceBootstrapPorts): ServiceHandler {
  return async (node, session) => {
    const owner = createServiceOwner(ports, async () => {
      const selected = await session.read({ children: node.$path })

      if (selected.next !== undefined) throw new KernelError('BUDGET', 'Service discovery exceeded its bounded page')
      const requests = new Map<NodeId, SelectedService>()

      for (const copy of selected.copies) {
        if ('error' in copy) throw copy.error
        if (!selected.list.includes(copy.node.$id)) continue

        let target = copy.node
        if (target.$type === 't.ref') {
          const path = target.$ref
          if (typeof path !== 'string') throw new KernelError('INVALID', 'Service reference needs a path')
          assertSafePath(path)

          const id = target.$refId
          if (id !== undefined && typeof id !== 'string') throw new KernelError('INVALID', 'Service reference identity is invalid')
          const resolved = id === undefined ? path : await ports.addressById(id)
          if (resolved === undefined) throw new KernelError('NOT_FOUND', 'Service reference target is absent')

          const referred = (await session.read({ node: resolved })).copies[0]
          if ('error' in referred) throw referred.error
          if (id !== undefined && referred.node.$id !== id)
            throw new KernelError('CONFLICT', 'Service reference identity changed')
          target = referred.node
        }

        const declarations = requests.get(target.$id)?.declarations ?? []
        declarations.push(copy.node)
        requests.set(target.$id, { path: target.$path, expected: target, declarations })
      }

      return [...requests.values()].map(request => ({
        ...request,
        /** Recheck declarations immediately before invoking the selected handler. */
        async validate() {
          for (const declaration of request.declarations) {
            const copy = (await session.read({ node: declaration.$path })).copies[0]
            if ('error' in copy) throw copy.error
            if (copy.node.$id !== declaration.$id || serviceConfiguration(copy.node) !== serviceConfiguration(declaration))
              throw new KernelError('CONFLICT', 'Service declaration changed')
          }
        },
      }))
    })
    let readyResolve = () => {}
    let readyReject = (_error: unknown) => {}

    const snapshot = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const sub = session.sub({ children: node.$path, include: [{ ref: '$ref' }] })

    const done = (async () => {
      try {
        for await (const frame of session.lane) {
          if (frame.t === 'snap' && frame.sub === sub) readyResolve()
          if (frame.t === 'end' && frame.sub === sub) throw frame.error
          if (frame.t === 'fail') throw frame.error
          if (frame.t === 'snap' || frame.t === 'pos' && frame.changes.length > 0)
            void owner.reconcile().catch(owner.reportReconciliation)
        }
        readyReject(new KernelError('CANCELLED', 'Discovery lane ended'))
        await owner.close()
      } catch (error) {
        if (error instanceof KernelError && (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED')) {
          readyReject(error)
          await owner.close()
          return
        }
        throw error
      }
    })()
    void done.catch(error => { readyReject(error) })
    try {
      await snapshot
      await owner.reconcile()
    } catch (error) {
      await owner.close()
      throw error
    }
    return {
      done,
      /** Drain owned children after the service owner closes this discovery session. */
      async stop() {
        await owner.close()
        await done
      },
    }
  }
}
