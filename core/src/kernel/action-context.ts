import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { createReader } from '#kernel/reader'
import type { Actor, ChangeBuilder, Io, NestedActRequest, Node, Path, ReadActionContext, ReadResult, Selector, WriteActionContext } from '#kernel/types'
import { freeze } from '#util/freeze'

/** Bind pre-effect waits and escaped context access to the request and parent lifetime. */
export function createActionControl(
  admission: AuthAdmission,
  deadline: number,
  parent?: () => void,
) {
  const controller = new AbortController()
  const signal = AbortSignal.any([admission.signal, controller.signal])
  let closed = false
  const timer = setTimeout(
    () => controller.abort(new KernelError('BUDGET', 'Action deadline exceeded')),
    Math.max(0, deadline - Date.now()),
  )
  timer.unref()

  /** Reject work after this request, its admission, or its parent has ended. */
  function active(): void {
    if (closed) throw new KernelError('INVALID', 'Action context has ended')
    parent?.()
    admission.assertActive()
    if (controller.signal.aborted) throw controller.signal.reason
    if (Date.now() > deadline) throw new KernelError('BUDGET', 'Action deadline exceeded')
  }

  /** Race pre-effect work against cancellation; Writer owns accepted commit completion. */
  async function wait<T>(pending: Promise<T>): Promise<T> {
    // Work can already be pending when cancellation refuses admission to this waiter.
    void pending.catch(() => {})
    active()
    let aborted: () => void = () => {}
    const stopped = new Promise<never>((_resolve, reject) => {
      aborted = () => {
        try {
          active()
        } catch (error) {
          reject(error)
        }
      }
      signal.addEventListener('abort', aborted, { once: true })
    })
    try {
      const result = await Promise.race([pending, stopped])
      active()
      return result
    } finally {
      signal.removeEventListener('abort', aborted)
    }
  }

  return {
    active,
    wait,
    signal,
    /** Revoke escaped access and release the request deadline timer. */
    close(): void {
      closed = true
      clearTimeout(timer)
      controller.abort(new KernelError('CANCELLED', 'Action context has ended'))
    },
  }
}

export interface ActionContextOptions {
  readonly node: Node
  readonly needs: Readonly<Record<string, ReadResult>>
  readonly reads: ReturnType<typeof createReader>
  readonly caller: Actor
  readonly executor: Actor
  readonly active: () => void
  readonly nested: (request: NestedActRequest) => Promise<unknown>
}
export type ActionContextSource = ActionContextOptions | (() => ActionContextOptions)

/** Expose immutable data through the same executor Reader and action lifetime. */
export function createReadActionContext(source: ActionContextSource): ReadActionContext {
  const current = typeof source === 'function' ? source : () => source
  return Object.freeze({
    get node() {
      const options = current()
      options.active()
      return freeze(options.node)
    },
    get needs() {
      const options = current()
      options.active()
      return freeze(options.needs)
    },
    get caller() {
      return current().caller
    },
    get executor() {
      return current().executor
    },
    read: Object.freeze({
      /** Capture additional reads in the action's shared OCC dependencies. */
      async read(selector: Selector) {
        const options = current()
        options.active()
        const result = await options.reads.read(selector)
        options.active()
        return freeze(result)
      },
    }),
    act: (request: NestedActRequest) => current().nested(request),
  })
}

/** Add the owned change builder and declared I/O to a writing action context. */
export function createWriteActionContext(
  source: ActionContextSource,
  change: ChangeBuilder | (() => ChangeBuilder),
  io?: Io,
): WriteActionContext {
  const current = typeof source === 'function' ? source : () => source
  const changes = typeof change === 'function' ? change : () => change
  const read = createReadActionContext(current)
  const stableChange: ChangeBuilder = {
    put: (node) => changes().put(node),
    patch: (path, ops) => changes().patch(path, ops),
    remove: (path) => changes().remove(path),
    move: (from, to) => changes().move(from, to),
    restore: (record) => changes().restore(record),
  }
  return Object.freeze({
    get node() {
      return read.node
    },
    get needs() {
      return read.needs
    },
    get caller() {
      return read.caller
    },
    get executor() {
      return read.executor
    },
    read: read.read,
    act: read.act,
    change: Object.freeze(stableChange),
    /** Keep destination authorization in the same executor read set and action lifetime. */
    async requireReadWrite(path: Path): Promise<void> {
      const options = current()
      options.active()
      await options.reads.requireReadWrite(path)
      options.active()
    },
    ...(io === undefined ? {} : { io }),
  })
}
