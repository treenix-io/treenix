import { createLaneCache } from '#client/lane-cache'
import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import { isReadResult } from '#protocol/twp'
import { createChunkChannel } from '#util/chunk-channel'
import type { ActRequest, CommitRequest, Connection, Frame, OpId, Outcome, Pending, ReadResult, Request, Selector, SubSelector } from '#kernel/types'

export interface NativeClientOptions { readonly maxRequests?: number; readonly close?: () => void; readonly onError?: (error: KernelError) => void }
export interface NodeSubscription { readonly id: string; readonly ready: Promise<void>; close(): void }
interface Waiting {
  readonly resolve: (outcome: Outcome) => void
  readonly reject: (error: KernelError) => void
  readonly chunks?: ReturnType<typeof createChunkChannel>
  cancelled?: boolean
}
interface Watching { readonly resolve: () => void; readonly reject: (error: KernelError) => void; readonly changed: () => void }

export function createTwpClient(connection: Connection, options: NativeClientOptions = {}) {
  const cache = createLaneCache(), waiting = new Map<string, Waiting>(), watching = new Map<string, Watching>()
  const maxRequests = options.maxRequests ?? 8
  const controller = new AbortController()
  let sequence = 0, welcome: Extract<Frame, { t: 'welcome' }> | undefined, failure: KernelError | undefined
  let readyResolve: (frame: Extract<Frame, { t: 'welcome' }>) => void = () => {}, readyReject: (error: KernelError) => void = () => {}
  const ready = new Promise<Extract<Frame, { t: 'welcome' }>>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  function close(reason?: KernelError): void {
    if (failure !== undefined) return
    const error = reason ?? new KernelError('CANCELLED', 'Client closed')
    failure = error
    readyReject(error)
    for (const request of waiting.values()) { request.chunks?.end(error); request.reject(error) }
    for (const sub of watching.values()) sub.reject(error)
    waiting.clear(); watching.clear(); cache.clear()
    controller.abort(error)
    options.close?.()
    if (reason !== undefined) options.onError?.(error)
  }
  function active(): void {
    if (failure !== undefined) throw failure
    if (welcome === undefined) throw new KernelError('UNAVAILABLE', 'Client handshake is pending')
  }
  function key(): OpId {
    active()
    const current = welcome
    if (current === undefined) throw new KernelError('UNAVAILABLE', 'Client handshake is pending')
    return { epoch: current.intake, time: Date.now(), nonce: crypto.randomUUID() }
  }
  /** Cancels the selected consumer while retaining its request until the canonical answer arrives. */
  function cancel(id: string): void {
    active()
    const pending = waiting.get(id)
    if (pending !== undefined) {
      pending.cancelled = true
      pending.chunks?.end(new KernelError('CANCELLED', 'Request cancelled'))
    }
    connection.send({ t: 'cancel', req: id })
  }

  /** Creates a correlated request with an optional single-consumer piece stream. */
  function request(build: (req: string) => Request, pieces = false): Pending {
    active()
    if (waiting.size >= maxRequests)
      throw new KernelError('BUDGET', 'Too many unfinished client requests')
    const id = String(++sequence)
    const chunks = pieces ? createChunkChannel(() => cancel(id)) : undefined
    const outcome = new Promise<Outcome>((resolve, reject) => {
      waiting.set(id, { resolve, reject, chunks })
      try {
        connection.send(build(id))
      } catch (error) {
        waiting.delete(id)
        chunks?.end(error)
        reject(error)
      }
    })
    // A pieces consumer may see the refusal before awaiting the unchanged outcome promise.
    if (pieces) void outcome.catch(() => {})
    return { id, outcome, chunks: chunks?.chunks ?? (async function* () {})() }
  }
  /** Routes incoming frames to their owning request, subscription, or lane cache. */
  async function consume(): Promise<void> {
    try {
      for await (const frame of connection.frames) {
        if (failure !== undefined) return
        if (frame.t === 'welcome') {
          if (welcome !== undefined) throw new KernelError('INVALID', 'Duplicate client handshake')
          welcome = frame
          cache.apply(frame)
          readyResolve(frame)
          continue
        }
        if (frame.t === 'fail') {
          const error = new KernelError(frame.error.code, frame.error.message)
          if (frame.req === undefined) throw error
          const pending = waiting.get(frame.req)
          if (pending === undefined) throw new KernelError('INVALID', 'Unknown failed request')
          waiting.delete(frame.req)
          pending.chunks?.end(error)
          pending.reject(error)
          continue
        }
        active()
        if (frame.t === 'done') {
          const pending = waiting.get(frame.req)
          if (pending === undefined) throw new KernelError('INVALID', 'Unknown completed request')
          if (frame.pos !== undefined) {
            const covered = cache.watermark(frame.pos.instance)
            if (covered === undefined || comparePositions(covered, frame.pos) < 0)
              throw new KernelError('INVALID', 'Mutation completed before its position frame')
          }
          waiting.delete(frame.req)
          pending.chunks?.end()
          pending.resolve({ pos: frame.pos, value: frame.value })
          continue
        }
        if (frame.t === 'chunk') {
          const pending = waiting.get(frame.req)
          if (pending === undefined || pending.chunks === undefined)
            throw new KernelError('INVALID', 'Unknown streaming request')
          // Late pieces of an explicitly cancelled request have no consumer; its final answer still does.
          if (pending.cancelled) continue
          try {
            await pending.chunks.deliver(frame.data, controller.signal)
          } catch (error) {
            if (!pending.cancelled || !(error instanceof KernelError && error.code === 'CANCELLED'))
              throw error
          }
          continue
        }
        cache.apply(frame)
        if (
          (frame.t === 'snap' ||
            frame.t === 'result' ||
            frame.t === 'reset' ||
            frame.t === 'end') &&
          !watching.has(frame.sub)
        )
          cache.forget(frame.sub)
        if (frame.t === 'end') {
          const sub = watching.get(frame.sub)
          watching.delete(frame.sub)
          sub?.reject(new KernelError(frame.error.code, frame.error.message))
        } else {
          if (frame.t === 'snap') watching.get(frame.sub)?.resolve()
          for (const sub of watching.values()) sub.changed()
        }
      }
      close(new KernelError('UNAVAILABLE', 'Lane disconnected'))
    } catch (error) {
      if (!(error instanceof KernelError)) console.error(error)
      close(
        error instanceof KernelError
          ? error
          : new KernelError('UNAVAILABLE', 'Client transport failed'),
      )
    }
  }
  void consume()
  return { ready, cache, key, failure: () => failure,
    read(selector: Selector): Promise<ReadResult> {
      return request(req => ({ t: 'read', req, selector })).outcome.then(result => {
        if (!isReadResult(result.value))
          throw new KernelError('INVALID', 'Malformed wire read result')
        return result.value
      })
    },
    commit(input: Omit<CommitRequest, 'opId'> & { readonly opId?: OpId }): Pending {
      const opId = input.opId ?? key()
      return request(req => ({ t: 'commit', req, changes: input.changes, expect: input.expect, opId }))
    },
    act(input: ActRequest): Pending {
      const opId = input.opId ?? key()
      return request(req => ({ t: 'act', req, path: input.path, component: input.component, action: input.action,
        args: input.args, anchor: input.anchor, opId }), true)
    },
    sub(selector: SubSelector, changed: () => void, refused?: (error: KernelError) => void): NodeSubscription {
      active()
      const id = `sub:${++sequence}`
      const ready = new Promise<void>((resolve, reject) => {
        watching.set(id, { resolve, reject(error) { reject(error); refused?.(error) }, changed })
        try { connection.send({ t: 'sub', sub: id, selector }) }
        catch (error) { watching.delete(id); reject(error) }
      })
      return { id, ready, close() {
        const pending = watching.get(id)
        if (pending !== undefined) {
          watching.delete(id); cache.forget(id); pending.reject(new KernelError('CANCELLED', 'Subscription closed'))
          if (failure === undefined) connection.send({ t: 'unsub', sub: id })
        }
      } }
    },
    cancel, close }
}

export type TwpClient = ReturnType<typeof createTwpClient>
