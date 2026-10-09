import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { NativeCommands } from '#kernel/commands'
import type { BlobTransfers } from '#kernel/blobs'
import type { createInstanceStream } from '#kernel/stream'
import { comparePositions } from '#kernel/position'
import { createSubscriptions, type NodeSubscription } from '#kernel/subscription'
import { createLaneDelivery } from '#kernel/lane-delivery'
import type { LaneSelectionSource } from '#kernel/lane-selection'
import { createChunkChannel } from '#util/chunk-channel'
import type { ActionPiece, ActionPieceDelivery, Credential, DomainId, Frame, LaneChange, Limits, NodeCopy, NodeId, Outcome, Path, Pending, Position, Request, ScanRange, Selector, Session, Sort, SubSelector } from '#kernel/types'

export type NodeSubSelector = SubSelector
export type NodeLaneCommand =
  | Extract<Request, { readonly t: 'commit' | 'act' | 'cancel' | 'unsub' }>
  | { readonly t: 'read'; readonly req: string; readonly selector: Selector }
  | { readonly t: 'sub'; readonly sub: string; readonly selector: SubSelector }

export interface NodeLaneImage {
  readonly copy: NodeCopy
  readonly before?: NodeCopy | null
  readonly bytes: number
  retain(): () => void
}
export interface NodeLaneRead extends LaneSelectionSource {
  readonly pos: Position
  image(path: Path, sort?: Sort): Promise<NodeLaneImage | null>
  check(): void
}
export interface NodeLaneOptions {
  readonly admission: AuthAdmission
  readonly commands: Pick<NativeCommands, 'read' | 'commit' | 'act'>
  readonly stream: Pick<ReturnType<typeof createInstanceStream>, 'cursor' | 'observe'>
  readonly limits: () => Limits
  readonly intake: () => string
  readonly read: <T>(run: (source: NodeLaneRead) => Promise<T>, selectors?: readonly SubSelector[]) => Promise<T>
  readonly gateSub: (selector: NodeSubSelector, signal: AbortSignal) => Promise<void>
  readonly registryChanged: (listener: () => void) => () => void
  /** Reports changed target ranges when the source supports dynamic mounts. */
  readonly topologyChanged?: (listener: (intersects: (range: ScanRange) => boolean) => void) => () => void
  /** Narrows a continuity reset to subscriptions reading that domain's logical ranges. */
  readonly domainIntersects?: (domain: DomainId, range: ScanRange) => boolean
  readonly issuedCredential?: Credential
  /** Kernel-owned node sessions can remain idle until their owner or authorization closes them. */
  readonly heartbeat?: boolean
  readonly transfers?: BlobTransfers
}
export type NodeLaneFrame = Extract<Frame, { readonly t: 'welcome' | 'snap' | 'pos' | 'chunk' | 'done' | 'fail' | 'end' | 'reset' }>

export interface NodeLane extends Session {
  readonly actor: AuthAdmission['actor']
  readonly frames: AsyncIterableIterator<NodeLaneFrame, void, undefined>
  accept(command: NodeLaneCommand): void
  read(selector: Selector): ReturnType<NativeCommands['read']>
  sub(selector: NodeSubSelector): string
  unsub(sub: string): void
  commit(request: Parameters<NativeCommands['commit']>[0]): Pending
  act(request: Parameters<NativeCommands['act']>[0]): Pending
  cancel(id: string): void
  touch(): void
  close(reason?: KernelError): void
  reconnect(): void
}
interface Mutation {
  readonly id: string
  readonly controller: AbortController
  readonly resolve: (outcome: Outcome) => void
  readonly reject: (error: KernelError) => void
  readonly chunks?: ReturnType<typeof createChunkChannel>
  piece?: { readonly value: ActionPiece; readonly taken: () => void }
  outcome?: Outcome
  error?: KernelError
}
type Control = Extract<NodeLaneFrame, { readonly t: 'end' | 'fail' | 'reset' }>
type CoverageChange = Extract<LaneChange, { readonly op: 'del' | 'list' }>
interface Pull {
  readonly resolve: (result: IteratorResult<NodeLaneFrame>) => void
  readonly reject: (error: KernelError) => void
}
const noChunks: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {} }

/** Schedules native requests and subscriptions; mutation completion follows its covering position. */
export function createNodeLane(options: NodeLaneOptions): NodeLane {
  const { admission } = options;
  admission.assertActive();
  const subscriptions = createSubscriptions();
  const mutations = new Map<string, Mutation>();
  const reads = new Map<
    string,
    { readonly selector: Selector; readonly controller: AbortController }
  >();
  const directReads = new Set<AbortController>();
  const transfers = new Set<AbortController>();
  const controls: Control[] = [];
  const removals = new Map<NodeId, CoverageChange>();
  const memberships: CoverageChange[] = [];
  const delivery = createLaneDelivery(options, subscriptions, registered, remove);
  const pulls: Pull[] = [];
  const prefix = crypto.randomUUID();
  let sequence = 0;
  let generation = 0;
  let welcome = true;
  let closed = false;
  let reconnecting = false;
  let draining = false;
  let notification = 0;
  let watermark: Position | undefined;
  let failure: KernelError | undefined;
  let takePiece: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();
  let unsubscribeStream = () => {};
  let unsubscribeRegistry = () => {};
  let unsubscribeTopology = () => {};
  /** Allocates a lane-local request or subscription identifier. */
  const id = () => `${prefix}:${++sequence}`;
  /** Rejects new work after the lane or its authorization closes. */
  const active = () => {
    if (closed || reconnecting) throw failure ?? new KernelError('CANCELLED', 'Lane is closed');
    admission.assertActive();
  };
  /** Preserves kernel refusals and reports unexpected operation failures. */
  const error = (caught: unknown): KernelError => {
    if (caught instanceof KernelError) return caught;
    console.error(caught);
    return new KernelError('UNAVAILABLE', 'Lane operation failed');
  };
  /** Bounds pending controls while allowing them to wake an existing pull. */
  function enqueue(control: Control): void {
    if (controls.length >= options.limits().subsPerLane + options.limits().laneRequests) {
      close(new KernelError('BUDGET', 'Lane control buffer exceeded'));
      return;
    }
    controls.push(control);
    wake();
  }
  /** Ends one subscription and queues releases of its shared coverage. */
  function remove(sub: NodeSubscription, reason?: KernelError): void {
    subscriptions.remove(sub);
    sub.controller.abort(reason ?? new KernelError('CANCELLED', 'Subscription ended'));
    for (const change of delivery.release(sub)) {
      if (change.op === 'del') removals.set(change.id, change);
      else if (change.op === 'list') memberships.push(change);
    }
    if (reason !== undefined) enqueue({ t: 'end', sub: sub.id, error: reason });
    wake();
  }
  /** Releases lane resources while preserving already accepted mutation outcomes. */
  function close(reason?: KernelError): void {
    if (closed) return;
    closed = true;
    failure = reason;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribeStream();
    unsubscribeRegistry();
    unsubscribeTopology();
    admission.signal.removeEventListener('abort', revoked);
    for (const sub of subscriptions.entries.values()) {
      sub.controller.abort(reason);
      subscriptions.remove(sub);
    }
    delivery.close();
    controls.length = 0;
    memberships.length = 0;
    removals.clear();
    for (const request of reads.values()) request.controller.abort(reason);
    for (const controller of directReads) controller.abort(reason);
    for (const controller of transfers) controller.abort(reason);
    reads.clear();
    // An accepted mutation must retain its canonical success even if delivery has ended.
    for (const request of mutations.values()) {
      request.chunks?.end(reason ?? new KernelError('CANCELLED', 'Lane is closed'));
      request.controller.abort(reason);
      if (request.outcome !== undefined) {
        request.resolve(request.outcome);
        mutations.delete(request.id);
      } else if (request.error !== undefined) {
        request.reject(request.error);
        mutations.delete(request.id);
      }
    }
    admission.close(reason);
    for (const pull of pulls.splice(0))
      reason === undefined ? pull.resolve({ done: true, value: undefined }) : pull.reject(reason);
  }
  /** Ends an old intake lane after its accepted outcomes have passed their covering position. */
  function reconnect(): void {
    if (closed || reconnecting) return
    reconnecting = true
    if (mutations.size === 0) close()
    else wake()
  }
  /** Closes delivery when the admission loses authority. */
  const revoked = () => close(error(admission.signal.reason));
  /** Expires a silent lane using its current configured heartbeat interval. */
  function heartbeat(): void {
    if (closed) return;
    const remaining = options.limits().heartbeatMs - (Date.now() - lastActivity);
    if (remaining <= 0) {
      close(new KernelError('UNAVAILABLE', 'Lane heartbeat expired'));
      return;
    }
    timer = setTimeout(heartbeat, Math.min(remaining, 2_147_483_647));
    timer.unref();
  }
  /** Refreshes activity only for an active lane. */
  function touch(): void {
    active();
    lastActivity = Date.now();
  }
  /** Prevents late asynchronous work from publishing a retired subscription. */
  function registered(sub: NodeSubscription): boolean {
    return !closed && subscriptions.current(sub);
  }
  /** Registers a selector before running its asynchronous subscription gate. */
  function subscribe(selector: NodeSubSelector, subId: string): void {
    active();
    if (subscriptions.entries.has(subId))
      throw new KernelError('INVALID', 'Subscription identifier is already active');
    if (subscriptions.entries.size >= options.limits().subsPerLane) {
      enqueue({
        t: 'end',
        sub: subId,
        error: new KernelError('BUDGET', 'Lane subscription limit exceeded'),
      });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(selector)) > options.limits().requestBytes) {
      enqueue({
        t: 'end',
        sub: subId,
        error: new KernelError('BUDGET', 'Subscription request budget exceeded'),
      });
      return;
    }
    const sub = subscriptions.add(subId, selector, ++generation);
    options.gateSub(selector, sub.controller.signal).then(
      () => {
        if (registered(sub)) {
          sub.ready = true;
          wake();
        }
      },
      (caught) => {
        if (registered(sub)) remove(sub, error(caught));
      },
    );
  }
  /** Refuses duplicate or excessive unfinished request identifiers. */
  function reserve(requestId: string): void {
    active();
    if (mutations.has(requestId) || reads.has(requestId))
      throw new KernelError('INVALID', 'Request identifier is already active');
    if (mutations.size + reads.size + directReads.size + transfers.size >= options.limits().laneRequests) {
      const denied = new KernelError('BUDGET', 'Unfinished request limit exceeded');
      close(denied);
      throw denied;
    }
  }
  /** Requires a covering ordinary frame before a piece or its final outcome is delivered. */
  function uncovered(pos: Position | undefined): boolean {
    return pos !== undefined && (watermark === undefined || comparePositions(pos, watermark) > 0);
  }
  /** Starts a cancellable mutation whose outcome settles after its completion frame. */
  function start(
    run: (signal: AbortSignal, deliver: ActionPieceDelivery) => Promise<Outcome>,
    requestId: string,
    owner: 'pending' | 'frames' | 'none' = 'none',
  ): Pending {
    reserve(requestId);
    let resolve!: Mutation['resolve'];
    let reject!: Mutation['reject'];
    const outcome = new Promise<Outcome>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Wire callers consume frames; attaching a rejection observer does not alter the direct Pending.
    void outcome.catch(() => {});
    const mutation: Mutation = {
      id: requestId,
      controller: new AbortController(),
      resolve,
      reject,
      chunks: owner === 'pending' ? createChunkChannel(() => cancel(requestId)) : undefined,
    };
    mutations.set(requestId, mutation);

    /** A direct Pending owns its pieces; wire calls own correlated lane frames, never both. */
    const deliver: ActionPieceDelivery = async (piece, signal) => {
      signal.throwIfAborted();
      if (closed) throw failure ?? new KernelError('CANCELLED', 'Lane is closed');
      if (owner === 'none') throw new KernelError('INVALID', 'Request has no piece consumer');
      if (mutation.piece !== undefined)
        throw new KernelError('INVALID', 'Piece delivery is pending');
      if (owner === 'frames' || uncovered(piece.pos)) {
        let abort = () => {};
        try {
          await new Promise<void>((resolve, reject) => {
            const held = { value: piece, taken: resolve };
            mutation.piece = held;
            abort = () => {
              if (mutation.piece === held) mutation.piece = undefined;
              reject(signal.reason);
              wake();
            };
            signal.addEventListener('abort', abort, { once: true });
            wake();
          });
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }
      if (mutation.chunks !== undefined) await mutation.chunks.deliver(piece.data, signal);
    };

    run(mutation.controller.signal, deliver).then(
      (result) => {
        mutation.outcome = result;
        if (closed) {
          mutation.chunks?.end();
          mutation.resolve(result);
          mutations.delete(requestId);
        } else wake();
      },
      (caught) => {
        mutation.error = error(caught);
        if (closed) {
          mutation.chunks?.end(mutation.error);
          mutation.reject(mutation.error);
          mutations.delete(requestId);
        } else wake();
      },
    );
    return { id: requestId, chunks: mutation.chunks?.chunks ?? noChunks, outcome };
  }
  /** Cancels unfinished work without discarding an accepted mutation outcome. */
  function cancel(requestId: string): void {
    const mutation = mutations.get(requestId);
    if (mutation !== undefined && mutation.outcome === undefined) {
      const denied = new KernelError('CANCELLED', 'Request cancelled');
      mutation.chunks?.end(denied);
      mutation.controller.abort(denied);
    }
    reads.get(requestId)?.controller.abort(new KernelError('CANCELLED', 'Request cancelled'));
    wake();
  }
  /** Starts new projection generations and requests fresh snapshots. */
  function reset(affected: (sub: NodeSubscription) => boolean = () => true): void {
    for (const sub of subscriptions.entries.values()) {
      if (!affected(sub)) continue;
      sub.gen = ++generation;
      sub.initial = true;
      subscriptions.dirty(sub, true);
      enqueue({ t: 'reset', sub: sub.id, gen: sub.gen });
    }
  }
  /** Includes absent selector ranges and inherited rights alongside current copy dependencies. */
  function intersectsSubscription(
    sub: NodeSubscription,
    intersects: (range: ScanRange) => boolean,
  ): boolean {
    const range = 'node' in sub.selector ? { node: sub.selector.node } : { children: sub.selector.children };
    if (intersects(range)) return true;

    for (const branch of [sub.state.fixed, ...sub.state.roots.values()]) {
      for (const path of branch.paths) if (intersects({ node: path })) return true;
      for (const path of branch.rights) if (intersects({ node: path })) return true;
    }
    return false;
  }
  /** Requires ordinary progress before dirty subscriptions or accepted mutations can complete. */
  function ordinaryNeeded(): boolean {
    if (
      [...subscriptions.entries.values()].some((sub) => sub.ready && !sub.initial && sub.dirty > 0)
    )
      return true;
    for (const request of mutations.values())
      if (uncovered(request.piece?.value.pos) || uncovered(request.outcome?.pos)) return true;
    return false;
  }
  /** Publishes a snapshot and retains coverage releases at the delivered watermark. */
  async function snapshot(sub: NodeSubscription): Promise<NodeLaneFrame | undefined> {
    try {
      const result = await delivery.snapshot(sub);
      if (result !== undefined) {
        for (const id of result.removed) removals.set(id, { op: 'del', id });
        for (const id of result.frame.covered ?? result.frame.list) removals.delete(id);
        watermark ??= result.frame.at[0];
      }
      return result?.frame;
    } catch (caught) {
      const denied = error(caught);
      if (denied.code !== 'CONFLICT' && registered(sub)) remove(sub, denied);
      return undefined;
    }
  }
  /** Publishes current changes once and suppresses queued deletions of transferred coverage. */
  async function flush(): Promise<NodeLaneFrame | undefined> {
    const dirty = [...subscriptions.entries.values()].filter(
      (sub) => sub.ready && !sub.initial && sub.dirty > 0,
    );
    try {
      const result = await delivery.flush(dirty, (pos) => {
        if (closed) return false;
        if (watermark !== undefined && comparePositions(pos, watermark) <= 0) {
          if (dirty.length > 0) reset();
          return false;
        }
        return true;
      });
      if (result === undefined) return undefined;
      for (const id of removals.keys()) if (delivery.covers(id)) removals.delete(id);
      watermark = result.pos;
      return { t: 'pos', pos: result.pos, changes: result.changes };
    } catch (caught) {
      const denied = error(caught);
      if (denied.code !== 'CONFLICT') close(denied);
      return undefined;
    }
  }
  /** Orders controls, covering positions, snapshots and request completion for one pull. */
  async function nextFrame(): Promise<NodeLaneFrame | undefined> {
    if (welcome) {
      welcome = false;
      return {
        t: 'welcome',
        principal: admission.actor.principal,
        intake: options.intake(),
        ...(options.issuedCredential === undefined ? {} : { credential: options.issuedCredential }),
      };
    }
    const control = controls.shift();
    if (control !== undefined) return control;
    if (watermark !== undefined && (removals.size > 0 || memberships.length > 0)) {
      const changes = [...removals.values(), ...memberships];
      removals.clear();
      memberships.length = 0;
      return { t: 'pos', pos: watermark, coverage: true, changes };
    }
    if (ordinaryNeeded()) return flush();
    for (const sub of subscriptions.entries.values())
      if (sub.ready && sub.initial) return snapshot(sub);
    for (const request of mutations.values()) {
      if (request.piece !== undefined) {
        const held = request.piece;
        request.piece = undefined;
        if (request.chunks !== undefined) held.taken();
        else {
          takePiece = held.taken;
          return { t: 'chunk', req: request.id, data: held.value.data };
        }
      }
      if (request.error !== undefined) {
        mutations.delete(request.id);
        request.chunks?.end(request.error);
        request.reject(request.error);
        return { t: 'fail', req: request.id, error: request.error };
      }
      if (request.outcome !== undefined) {
        mutations.delete(request.id);
        request.chunks?.end();
        request.resolve(request.outcome);
        return { t: 'done', req: request.id, ...request.outcome };
      }
    }
    const firstRead = reads.entries().next();
    if (!firstRead.done) {
      const [requestId, request] = firstRead.value;
      try {
        const result = await options.commands.read(request.selector, request.controller.signal);
        if (closed) return undefined;
        reads.delete(requestId);
        return { t: 'done', req: requestId, value: result };
      } catch (caught) {
        reads.delete(requestId);
        return { t: 'fail', req: requestId, error: error(caught) };
      }
    }
    if (reconnecting && mutations.size === 0) close();
    return undefined;
  }
  /** Drains only waiting pulls and rechecks notifications received during preparation. */
  function wake(): void {
    notification++;
    if (draining || closed || pulls.length === 0) return;
    draining = true;
    let observed = notification;
    void (async () => {
      try {
        while (!closed && pulls.length > 0) {
          observed = notification;
          const frame = await nextFrame();
          const taken = takePiece;
          takePiece = undefined;
          if (closed) break;
          if (frame === undefined) {
            if (observed !== notification) continue;
            break;
          }
          pulls.shift()!.resolve({ done: false, value: frame });
          // The producer resumes after the owning pull takes the chunk, never after enqueueing it.
          taken?.();
        }
      } catch (caught) {
        close(error(caught));
      } finally {
        draining = false;
        if (observed !== notification) wake();
      }
    })();
  }
  const frames: AsyncIterableIterator<NodeLaneFrame, void, undefined> = {
    /** Pulls one frame without retaining a queue of node payloads. */
    next() {
      if (closed)
        return failure === undefined
          ? Promise.resolve({ done: true, value: undefined })
          : Promise.reject(failure);
      if (pulls.length >= options.limits().laneRequests)
        return Promise.reject(new KernelError('BUDGET', 'Lane pull limit exceeded'));
      return new Promise((resolve, reject) => {
        pulls.push({ resolve, reject });
        wake();
      });
    },
    /** Ends the lane when its consumer stops pulling. */
    async return() {
      close();
      return { done: true, value: undefined };
    },
    /** Closes the lane with the consumer failure. */
    async throw(caught) {
      const denied = error(caught);
      close(denied);
      throw denied;
    },
    [Symbol.asyncIterator]() {
      return frames;
    },
  };
  unsubscribeStream = options.stream.observe((event) => {
    if (event.t === 'reset')
      reset(sub => options.domainIntersects === undefined
        || sub.state.domains.includes(event.domain)
          && intersectsSubscription(sub, range => options.domainIntersects!(event.domain, range)));
    else if (event.t === 'commit')
      for (const entry of event.record.entries) {
        const force =
          entry.change.t !== 'update' ||
          entry.from !== undefined ||
          Object.keys(entry.change.delta).some(
            (path) =>
              path === '$acl' ||
              path.startsWith('$acl.') ||
              path === '$owner' ||
              path === '$type' ||
              path.startsWith('#') ||
              path.endsWith('.$type') ||
              path === '$v' ||
              path.endsWith('.$v'),
          );
        subscriptions.changed(entry.path, force, options.limits().readNodes);
        if (entry.from !== undefined)
          subscriptions.changed(entry.from, true, options.limits().readNodes);
      }
    wake();
  });
  unsubscribeRegistry = options.registryChanged(() => {
    reset();
    wake();
  });
  unsubscribeTopology = options.topologyChanged?.(intersects => {
    reset(sub => intersectsSubscription(sub, intersects));
    wake();
  }) ?? (() => {});
  admission.signal.addEventListener('abort', revoked, { once: true });
  admission.assertActive();
  if (options.heartbeat !== false) heartbeat();
  return {
    actor: admission.actor,
    frames,
    lane: frames,
    close,
    reconnect,
    touch,
    cancel,
    /** Counts binary uploads in the same unfinished-request quota as commands. */
    async upload(parts, type) {
      touch();
      reserve(id());
      const producer = options.transfers;
      if (producer === undefined) throw new KernelError('UNAVAILABLE', 'Blob storage is not configured');
      const controller = new AbortController();
      transfers.add(controller);

      try { return await producer.upload(parts, type, controller.signal); }
      finally { transfers.delete(controller); }
    },
    /** Holds one request slot while the consumer pulls binary content. */
    async *download(path, field) {
      touch();
      reserve(id());
      const producer = options.transfers;
      if (producer === undefined) throw new KernelError('UNAVAILABLE', 'Blob storage is not configured');
      const controller = new AbortController();
      transfers.add(controller);

      try { yield* producer.download(path, field, controller.signal); }
      finally { transfers.delete(controller); }
    },
    read: (selector) => {
      touch();
      reserve(id());
      const controller = new AbortController();
      directReads.add(controller);
      return options.commands
        .read(selector, controller.signal)
        .finally(() => directReads.delete(controller));
    },
    sub: (selector) => {
      touch();
      const subId = id();
      subscribe(selector, subId);
      return subId;
    },
    unsub: (subId) => {
      touch();
      const sub = subscriptions.entries.get(subId);
      if (sub !== undefined) remove(sub);
    },
    commit: (request) => {
      touch();
      return start((signal) => options.commands.commit(request, signal), id());
    },
    act: (request) => {
      touch();
      return start((signal, deliver) => options.commands.act(request, signal, deliver), id(), 'pending');
    },
    /** Preserves wire correlation while scheduling an admitted native command. */
    accept(command) {
      touch();
      if (Buffer.byteLength(JSON.stringify(command)) > options.limits().requestBytes)
        throw new KernelError('BUDGET', 'Lane request budget exceeded');
      if (command.t === 'sub') subscribe(command.selector, command.sub);
      else if (command.t === 'unsub') {
        const sub = subscriptions.entries.get(command.sub);
        if (sub !== undefined) remove(sub);
      } else if (command.t === 'commit')
        start((signal) => options.commands.commit(command, signal), command.req);
      else if (command.t === 'act')
        start((signal, deliver) => options.commands.act(command, signal, deliver), command.req, 'frames');
      else if (command.t === 'cancel') cancel(command.req);
      else {
        reserve(command.req);
        reads.set(command.req, {
          selector: structuredClone(command.selector),
          controller: new AbortController(),
        });
        wake();
      }
    },
  };
}
