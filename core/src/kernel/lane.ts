import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { NativeCommands } from '#kernel/commands'
import type { createInstanceStream } from '#kernel/stream'
import { comparePositions } from '#kernel/position'
import { createSubscriptions, type NodeSubscription } from '#kernel/subscription'
import { computeDelta } from '#kernel/update-ops'
import type { Credential, Frame, LaneChange, Limits, NodeCopy, NodeId, Outcome, Path, Pending, Position, Request, SubSelector } from '#kernel/types'

export interface NodeSubSelector { readonly node: Path }
export type NodeLaneCommand =
  | Extract<Request, { readonly t: 'commit' | 'act' | 'cancel' | 'unsub' }>
  | { readonly t: 'read'; readonly req: string; readonly selector: SubSelector }
  | { readonly t: 'sub'; readonly sub: string; readonly selector: NodeSubSelector }

export interface NodeLaneImage {
  readonly copy: NodeCopy
  readonly before?: NodeCopy | null
  readonly bytes: number
  retain(): () => void
}
export interface NodeLaneRead {
  readonly pos: Position
  image(path: Path): Promise<NodeLaneImage | null>
  check(): void
}
export interface NodeLaneOptions {
  readonly admission: AuthAdmission
  readonly commands: Pick<NativeCommands, 'read' | 'commit' | 'act'>
  readonly stream: Pick<ReturnType<typeof createInstanceStream>, 'cursor' | 'observe'>
  readonly limits: () => Limits
  readonly intake: () => string
  readonly read: <T>(run: (source: NodeLaneRead) => Promise<T>) => Promise<T>
  readonly gateSub: (selector: NodeSubSelector, signal: AbortSignal) => Promise<void>
  readonly registryChanged: (listener: () => void) => () => void
  readonly issuedCredential?: Credential
}
export type NodeLaneFrame = Extract<Frame, { readonly t: 'welcome' | 'snap' | 'pos' | 'done' | 'fail' | 'end' | 'reset' }>

export interface NodeLane {
  readonly actor: AuthAdmission['actor']
  readonly frames: AsyncIterableIterator<NodeLaneFrame, void, undefined>
  accept(command: NodeLaneCommand): void
  read(selector: SubSelector): ReturnType<NativeCommands['read']>
  sub(selector: NodeSubSelector): string
  unsub(sub: string): void
  commit(request: Parameters<NativeCommands['commit']>[0]): Pending
  act(request: Parameters<NativeCommands['act']>[0]): Pending
  cancel(id: string): void
  touch(): void
  close(reason?: KernelError): void
}

interface Coverage { count: number; bytes: number; readonly release: () => void }
interface Mutation {
  readonly id: string
  readonly controller: AbortController
  readonly resolve: (outcome: Outcome) => void
  readonly reject: (error: KernelError) => void
  outcome?: Outcome
  error?: KernelError
}
type Control = Extract<NodeLaneFrame, { readonly t: 'end' | 'fail' | 'reset' }>
type CoverageChange = Extract<LaneChange, { readonly op: 'del' | 'list' }>
interface Pull {
  readonly resolve: (result: IteratorResult<NodeLaneFrame>) => void
  readonly reject: (error: KernelError) => void
}
const copyId = (copy: NodeCopy): NodeId => 'node' in copy ? copy.node.$id : copy.id
const noChunks: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {} }

export function createNodeLane(options: NodeLaneOptions): NodeLane {
  const { admission } = options
  admission.assertActive()
  const subscriptions = createSubscriptions(), coverage = new Map<NodeId, Coverage>()
  const mutations = new Map<string, Mutation>()
  const reads = new Map<string, { readonly selector: SubSelector; readonly controller: AbortController }>()
  const directReads = new Set<AbortController>()
  const controls: Control[] = [], removals = new Map<NodeId, CoverageChange>()
  const memberships: CoverageChange[] = []
  const pulls: Pull[] = []
  const prefix = crypto.randomUUID()
  let sequence = 0, generation = 0, welcome = true, closed = false, draining = false, notification = 0
  let watermark: Position | undefined, failure: KernelError | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, lastActivity = Date.now()
  let unsubscribeStream = () => {}, unsubscribeRegistry = () => {}
  const id = () => `${prefix}:${++sequence}`
  const active = () => { if (closed) throw failure ?? new KernelError('CANCELLED', 'Lane is closed'); admission.assertActive() }
  const error = (caught: unknown): KernelError => {
    if (caught instanceof KernelError) return caught
    console.error(caught)
    return new KernelError('UNAVAILABLE', 'Lane operation failed')
  }
  function enqueue(control: Control): void {
    if (controls.length >= options.limits().subsPerLane + options.limits().laneRequests) {
      close(new KernelError('BUDGET', 'Lane control buffer exceeded')); return
    }
    controls.push(control)
    wake()
  }
  function releaseMember(sub: NodeSubscription, control: boolean): void {
    if (sub.member === undefined) return
    const member = sub.member, covered = coverage.get(member)!
    covered.count--
    if (covered.count === 0) {
      covered.release(); coverage.delete(member)
      if (control) removals.set(member, { op: 'del', id: member })
    }
    if (control) memberships.push({ op: 'list', sub: sub.id, gen: sub.gen, diff: [{ remove: member }] })
    sub.member = undefined
  }
  function remove(sub: NodeSubscription, reason?: KernelError): void {
    subscriptions.remove(sub)
    sub.controller.abort(reason ?? new KernelError('CANCELLED', 'Subscription ended'))
    releaseMember(sub, true)
    if (reason !== undefined) enqueue({ t: 'end', sub: sub.id, error: reason })
    wake()
  }
  function close(reason?: KernelError): void {
    if (closed) return
    closed = true; failure = reason
    if (timer !== undefined) clearTimeout(timer)
    unsubscribeStream(); unsubscribeRegistry()
    admission.signal.removeEventListener('abort', revoked)
    for (const sub of subscriptions.entries.values()) sub.controller.abort(reason)
    subscriptions.entries.clear()
    for (const held of coverage.values()) held.release()
    coverage.clear(); controls.length = 0; memberships.length = 0; removals.clear()
    for (const request of reads.values()) request.controller.abort(reason)
    for (const controller of directReads) controller.abort(reason)
    reads.clear()
    // An accepted mutation must retain its canonical success even if delivery has ended.
    for (const request of mutations.values()) {
      request.controller.abort(reason)
      if (request.outcome !== undefined) { request.resolve(request.outcome); mutations.delete(request.id) }
      else if (request.error !== undefined) { request.reject(request.error); mutations.delete(request.id) }
    }
    admission.close(reason)
    for (const pull of pulls.splice(0)) reason === undefined ? pull.resolve({ done: true, value: undefined }) : pull.reject(reason)
  }
  const revoked = () => close(error(admission.signal.reason))
  function heartbeat(): void {
    if (closed) return
    const remaining = options.limits().heartbeatMs - (Date.now() - lastActivity)
    if (remaining <= 0) { close(new KernelError('UNAVAILABLE', 'Lane heartbeat expired')); return }
    timer = setTimeout(heartbeat, Math.min(remaining, 2_147_483_647)); timer.unref()
  }
  function touch(): void { active(); lastActivity = Date.now() }
  function registered(sub: NodeSubscription): boolean { return !closed && subscriptions.current(sub) }
  function subscribe(selector: NodeSubSelector, subId: string): void {
    active()
    if (subscriptions.entries.has(subId)) throw new KernelError('INVALID', 'Subscription identifier is already active')
    if (subscriptions.entries.size >= options.limits().subsPerLane) {
      enqueue({ t: 'end', sub: subId, error: new KernelError('BUDGET', 'Lane subscription limit exceeded') }); return
    }
    if (Buffer.byteLength(JSON.stringify(selector)) > options.limits().requestBytes) {
      enqueue({ t: 'end', sub: subId, error: new KernelError('BUDGET', 'Subscription request budget exceeded') }); return
    }
    const sub = subscriptions.add(subId, selector.node, ++generation)
    options.gateSub({ node: sub.path }, sub.controller.signal).then(() => {
      if (registered(sub)) { sub.ready = true; wake() }
    }, caught => { if (registered(sub)) remove(sub, error(caught)) })
  }
  function reserve(requestId: string): void {
    active()
    if (mutations.has(requestId) || reads.has(requestId)) throw new KernelError('INVALID', 'Request identifier is already active')
    if (mutations.size + reads.size + directReads.size >= options.limits().laneRequests) {
      const denied = new KernelError('BUDGET', 'Unfinished request limit exceeded')
      close(denied); throw denied
    }
  }
  function start(run: (signal: AbortSignal) => Promise<Outcome>, requestId: string): Pending {
    reserve(requestId)
    let resolve!: Mutation['resolve'], reject!: Mutation['reject']
    const outcome = new Promise<Outcome>((yes, no) => { resolve = yes; reject = no })
    // Wire callers consume frames; attaching a rejection observer does not alter the direct Pending.
    void outcome.catch(() => {})
    const mutation: Mutation = { id: requestId, controller: new AbortController(), resolve, reject }
    mutations.set(requestId, mutation)
    run(mutation.controller.signal).then(result => {
      mutation.outcome = result
      if (closed) { mutation.resolve(result); mutations.delete(requestId) } else wake()
    }, caught => {
      mutation.error = error(caught)
      if (closed) { mutation.reject(mutation.error); mutations.delete(requestId) } else wake()
    })
    return { id: requestId, chunks: noChunks, outcome }
  }
  function cancel(requestId: string): void {
    const mutation = mutations.get(requestId)
    if (mutation !== undefined && mutation.outcome === undefined) mutation.controller.abort(new KernelError('CANCELLED', 'Request cancelled'))
    reads.get(requestId)?.controller.abort(new KernelError('CANCELLED', 'Request cancelled'))
    wake()
  }
  function coverageBytes(): number { let bytes = 0; for (const held of coverage.values()) bytes += held.bytes; return bytes }
  function reset(): void {
    for (const sub of subscriptions.entries.values()) {
      sub.gen = ++generation; sub.initial = true; subscriptions.dirty(sub, true)
      enqueue({ t: 'reset', sub: sub.id, gen: sub.gen })
    }
  }
  function ordinaryNeeded(): boolean {
    if ([...subscriptions.entries.values()].some(sub => sub.ready && !sub.initial && sub.dirty > 0)) return true
    for (const request of mutations.values()) if (request.outcome?.pos !== undefined
      && (watermark === undefined || comparePositions(request.outcome.pos, watermark) > 0)) return true
    return false
  }
  async function snapshot(sub: NodeSubscription): Promise<NodeLaneFrame | undefined> {
    const gen = sub.gen, stamp = sub.stamp
    let retained: (() => void) | undefined
    try {
      const result = await options.read(async source => {
        const image = await source.image(sub.path); source.check()
        if (!registered(sub) || sub.gen !== gen) return undefined
        if (image === null) throw new KernelError('NOT_FOUND', 'Subscription node is absent')
        const member = copyId(image.copy), prior = coverage.get(member)
        const bytes = coverageBytes() - (prior?.bytes ?? 0) + image.bytes
        if (bytes > options.limits().laneCoverageBytes) throw new KernelError('BUDGET', 'Lane coverage budget exceeded')
        if (prior === undefined) retained = image.retain()
        return { image, member, pos: source.pos, deliver: prior === undefined || sub.forcePut }
      })
      if (result === undefined || !registered(sub) || sub.gen !== gen) { retained?.(); return undefined }
      if (sub.member !== result.member) {
        releaseMember(sub, false)
        const prior = coverage.get(result.member)
        if (prior === undefined) {
          if (retained === undefined) throw new KernelError('INVALID', 'Coverage pin is missing')
          coverage.set(result.member, { count: 1, bytes: result.image.bytes, release: retained }); retained = undefined
        } else { prior.count++; retained?.(); retained = undefined }
        sub.member = result.member
      } else retained?.()
      coverage.get(result.member)!.bytes = result.image.bytes
      removals.delete(result.member)
      sub.initial = false
      if (stamp === sub.stamp) { sub.dirty = 0; sub.forcePut = false } else sub.dirty = 2
      watermark ??= result.pos
      return { t: 'snap', sub: sub.id, gen, list: [result.member], copies: result.deliver ? [result.image.copy] : [], at: [result.pos] }
    } catch (caught) {
      retained?.()
      const denied = error(caught)
      if (denied.code === 'CONFLICT') return undefined
      if (registered(sub)) remove(sub, denied)
      return undefined
    }
  }
  async function flush(): Promise<NodeLaneFrame | undefined> {
    const dirty = [...subscriptions.entries.values()].filter(sub => sub.ready && !sub.initial && sub.dirty > 0)
    const held = new Map<NodeId, () => void>()
    try {
      const result = await options.read(async source => {
        const images = new Map<Path, NodeLaneImage | null>()
        const staged: { sub: NodeSubscription; gen: number; stamp: number; dirty: number; force: boolean; image: NodeLaneImage | null }[] = []
        for (const sub of dirty) {
          let image = images.get(sub.path)
          if (image === undefined) { image = await source.image(sub.path); images.set(sub.path, image) }
          source.check()
          if (!registered(sub) || sub.initial) continue
          staged.push({ sub, gen: sub.gen, stamp: sub.stamp, dirty: sub.dirty, force: sub.forcePut, image })
        }
        for (const stage of staged) if (stage.image !== null) {
          const member = copyId(stage.image.copy)
          if (!held.has(member)) held.set(member, stage.image.retain())
        }
        source.check()
        return { staged, pos: source.pos }
      })
      if (closed) return undefined
      if (watermark !== undefined && comparePositions(result.pos, watermark) <= 0) {
        if (result.staged.length > 0) reset()
        return undefined
      }
      const stagedBySub = new Map(result.staged.map(stage => [stage.sub, stage]))
      const estimated = new Map<NodeId, number>()
      for (const sub of subscriptions.entries.values()) {
        const stage = stagedBySub.get(sub)
        const member = stage === undefined ? sub.member : stage.image === null ? undefined : copyId(stage.image.copy)
        if (member !== undefined) estimated.set(member, stage?.image?.bytes ?? coverage.get(member)!.bytes)
      }
      let total = 0; for (const bytes of estimated.values()) total += bytes
      if (total > options.limits().laneCoverageBytes) {
        const expanded = new Set<NodeId>()
        for (const stage of result.staged) if (stage.image !== null) {
          const member = copyId(stage.image.copy), prior = coverage.get(member)
          if (prior === undefined || stage.image.bytes > prior.bytes) expanded.add(member)
        }
        for (const sub of [...subscriptions.entries.values()]) {
          const stage = stagedBySub.get(sub)
          const member = stage === undefined ? sub.member : stage.image === null ? undefined : copyId(stage.image.copy)
          if (member !== undefined && expanded.has(member)) remove(sub, new KernelError('BUDGET', 'Lane coverage budget exceeded'))
        }
        return undefined
      }
      const changes: LaneChange[] = [], lists: LaneChange[] = [], deleted = new Set<NodeId>()
      const updates = new Map<NodeId, typeof result.staged[number]>()
      for (const stage of result.staged) {
        const { sub, image } = stage
        if (!registered(sub) || sub.gen !== stage.gen) continue
        const member = image === null ? undefined : copyId(image.copy), prior = sub.member
        if (prior !== member) {
          releaseMember(sub, false)
          if (prior !== undefined) {
            lists.push({ op: 'list', sub: sub.id, gen: sub.gen, diff: [{ remove: prior }] })
            deleted.add(prior)
          }
          if (member !== undefined && image !== null) {
            const covered = coverage.get(member)
            if (covered === undefined) {
              const release = held.get(member)
              if (release === undefined) throw new KernelError('INVALID', 'Coverage pin is missing')
              coverage.set(member, { count: 1, bytes: image.bytes, release }); held.delete(member)
            } else covered.count++
            sub.member = member; removals.delete(member)
            lists.push({ op: 'list', sub: sub.id, gen: sub.gen, diff: [{ add: member }] })
          }
        }
        if (member !== undefined && image !== null) {
          const covered = coverage.get(member)!
          covered.bytes = image.bytes
          updates.set(member, { ...stage, force: stage.force || prior !== member })
        }
        if (stage.stamp === sub.stamp) { sub.dirty = 0; sub.forcePut = false } else sub.dirty = 2
      }
      for (const [member, stage] of updates) {
        if (!coverage.has(member) || stage.image === null) continue
        const copy = stage.image.copy, before = stage.image.before
        if (stage.dirty === 1 && !stage.force && before !== undefined && before !== null
          && 'node' in before && 'node' in copy && before.bits === copy.bits) {
          changes.push({ op: 'patch', id: member, base: before.ver, delta: computeDelta(before.node, copy.node), ver: copy.ver, bits: copy.bits })
        } else changes.push({ op: 'put', copy })
      }
      changes.push(...lists)
      for (const member of deleted) if (!coverage.has(member)) changes.push({ op: 'del', id: member })
      watermark = result.pos
      return { t: 'pos', pos: result.pos, changes }
    } catch (caught) {
      const denied = error(caught)
      if (denied.code === 'CONFLICT') return undefined
      close(denied); return undefined
    } finally { for (const release of held.values()) release() }
  }
  async function nextFrame(): Promise<NodeLaneFrame | undefined> {
    if (welcome) { welcome = false; return { t: 'welcome', principal: admission.actor.principal,
      intake: options.intake(), ...(options.issuedCredential === undefined ? {} : { credential: options.issuedCredential }) } }
    const control = controls.shift()
    if (control !== undefined) return control
    if (watermark !== undefined && (removals.size > 0 || memberships.length > 0)) {
      const changes = [...removals.values(), ...memberships]; removals.clear(); memberships.length = 0
      return { t: 'pos', pos: watermark, coverage: true, changes }
    }
    if (ordinaryNeeded()) return flush()
    for (const sub of subscriptions.entries.values()) if (sub.ready && sub.initial) return snapshot(sub)
    for (const request of mutations.values()) {
      if (request.error !== undefined) {
        mutations.delete(request.id); request.reject(request.error)
        return { t: 'fail', req: request.id, error: request.error }
      }
      if (request.outcome !== undefined) {
        mutations.delete(request.id); request.resolve(request.outcome)
        return { t: 'done', req: request.id, ...request.outcome }
      }
    }
    const firstRead = reads.entries().next()
    if (!firstRead.done) {
      const [requestId, request] = firstRead.value
      try {
        const result = await options.commands.read(request.selector, request.controller.signal)
        if (closed) return undefined
        reads.delete(requestId)
        return { t: 'done', req: requestId, value: result }
      } catch (caught) {
        reads.delete(requestId)
        return { t: 'fail', req: requestId, error: error(caught) }
      }
    }
    return undefined
  }
  function wake(): void {
    notification++
    if (draining || closed || pulls.length === 0) return
    draining = true
    let observed = notification
    void (async () => {
      try {
        while (!closed && pulls.length > 0) {
          observed = notification
          const frame = await nextFrame()
          if (closed) break
          if (frame === undefined) { if (observed !== notification) continue; break }
          pulls.shift()!.resolve({ done: false, value: frame })
        }
      } catch (caught) { close(error(caught)) }
      finally { draining = false; if (observed !== notification) wake() }
    })()
  }
  const frames: AsyncIterableIterator<NodeLaneFrame, void, undefined> = {
    next() {
      if (closed) return failure === undefined ? Promise.resolve({ done: true, value: undefined }) : Promise.reject(failure)
      if (pulls.length >= options.limits().laneRequests) return Promise.reject(new KernelError('BUDGET', 'Lane pull limit exceeded'))
      return new Promise((resolve, reject) => { pulls.push({ resolve, reject }); wake() })
    },
    async return() { close(); return { done: true, value: undefined } },
    async throw(caught) { const denied = error(caught); close(denied); throw denied },
    [Symbol.asyncIterator]() { return frames },
  }
  unsubscribeStream = options.stream.observe(event => {
    if (event.t === 'reset') reset()
    else if (event.t === 'commit') for (const entry of event.record.entries) {
      const force = entry.change.t !== 'update' || entry.from !== undefined
        || Object.keys(entry.change.delta).some(path => path === '$acl' || path.startsWith('$acl.')
          || path === '$owner' || path === '$type' || path.endsWith('.$type') || path === '$v' || path.endsWith('.$v'))
      subscriptions.changed(entry.path, force)
      if (entry.from !== undefined) subscriptions.changed(entry.from, true)
    }
    wake()
  })
  unsubscribeRegistry = options.registryChanged(() => { reset(); wake() })
  admission.signal.addEventListener('abort', revoked, { once: true })
  admission.assertActive(); heartbeat()
  return {
    actor: admission.actor, frames, close, touch, cancel,
    read: selector => {
      touch(); reserve(id())
      const controller = new AbortController(); directReads.add(controller)
      return options.commands.read(selector, controller.signal).finally(() => directReads.delete(controller))
    },
    sub: selector => { touch(); const subId = id(); subscribe(selector, subId); return subId },
    unsub: subId => { touch(); const sub = subscriptions.entries.get(subId); if (sub !== undefined) remove(sub) },
    commit: request => { touch(); return start(signal => options.commands.commit(request, signal), id()) },
    act: request => { touch(); return start(signal => options.commands.act(request, signal), id()) },
    accept(command) {
      touch()
      if (Buffer.byteLength(JSON.stringify(command)) > options.limits().requestBytes) throw new KernelError('BUDGET', 'Lane request budget exceeded')
      if (command.t === 'sub') subscribe(command.selector, command.sub)
      else if (command.t === 'unsub') { const sub = subscriptions.entries.get(command.sub); if (sub !== undefined) remove(sub) }
      else if (command.t === 'commit') start(signal => options.commands.commit(command, signal), command.req)
      else if (command.t === 'act') start(signal => options.commands.act(command, signal), command.req)
      else if (command.t === 'cancel') cancel(command.req)
      else { reserve(command.req); reads.set(command.req, { selector: structuredClone(command.selector), controller: new AbortController() }); wake() }
    },
  }
}
