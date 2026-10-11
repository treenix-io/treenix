import type { ReadQueryCost, ReadReceipt } from '#kernel/types'
import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { NativeCommands, ReadAccounting } from '#kernel/commands'
import type { BlobTransfers } from '#kernel/blobs'
import type { createInstanceStream } from '#kernel/stream'
import { comparePositions } from '#kernel/position'
import { serializeKernel } from '#kernel/serialization'
import { createSubscriptions, type NodeSubscription } from '#kernel/subscription'
import { createLaneDelivery } from '#kernel/lane-delivery'
import type { LaneSelectionSource, LaneProjection } from '#kernel/lane-selection'
import type { ViewSubscription } from '#kernel/view'
import { createChunkChannel } from '#util/chunk-channel'
import type {
  Budget,
  ActionPiece,
  ActionPieceDelivery,
  CacheClaim,
  Credential,
  DomainId,
  Frame,
  LaneChange,
  LaneProducer,
  Limits,
  Node,
  NodeCopy,
  NodeId,
  Outcome,
  Path,
  Pending,
  Position,
  Request,
  ScanRange,
  Selector,
  Session,
  Sort,
  SubSelector,
} from '#kernel/types'

export type NodeSubSelector = SubSelector
export type NodeLaneCommand =
  | Extract<Request, { readonly t: 'commit' | 'act' | 'cancel' | 'unsub' }>
  | { readonly t: 'read'; readonly req: string; readonly selector: Selector }
  | { readonly t: 'sub'; readonly sub: string; readonly selector: SubSelector }

export interface NodeLaneImage {
  readonly copy: NodeCopy
  readonly visible: Node
  readonly before?: NodeCopy | null
  readonly bytes: number
  readonly position?: Position
  retain(): () => void
}
export interface NodeLaneRead extends LaneSelectionSource {
  readonly pos: Position
  /** Intake epoch associated with this ordered read. */
  readonly intake: string
  /** Checks whether this ordered read may reuse a retained copy for a path. */
  claimable(path: Path): boolean
  image(path: Path, sort?: Sort): Promise<NodeLaneImage | null>
  check(): void
  authorizeView?(selector: SubSelector): Promise<void>
}
export interface NodeLaneOptions {
  readonly admission: AuthAdmission
  readonly commands: Pick<NativeCommands, 'read' | 'commit' | 'act'>
  readonly stream: Pick<ReturnType<typeof createInstanceStream>, 'cursor' | 'observe'>
  readonly limits: () => Limits
  readonly intake: () => string
  readonly read: <T>(run: (source: NodeLaneRead) => Promise<T>, selectors?: readonly SubSelector[], prepare?: (budget: Budget) => Promise<Budget>) => Promise<T>
  readonly gateSub: (selector: NodeSubSelector, signal: AbortSignal) => Promise<void>
  readonly registryChanged: (listener: () => void) => () => void
  /** Reports changed target ranges when the source supports dynamic mounts. */
  readonly topologyChanged?: (listener: (intersects: (range: ScanRange) => boolean) => void) => () => void
  /** Narrows a continuity reset to subscriptions reading that domain's logical ranges. */
  readonly domainIntersects?: (domain: DomainId, range: ScanRange) => boolean
  readonly issuedCredential?: Credential
  readonly cache?: readonly CacheClaim[]
  /** Kernel-owned node sessions can remain idle until their owner or authorization closes them. */
  readonly heartbeat?: boolean
  readonly transfers?: BlobTransfers
  readonly shard?: {
    poll(): Promise<NodeLaneFrame | undefined>
    observe(listener: () => void): () => void
    close(): void
  }
  readonly openShard?: (selector: SubSelector, id: string, generation: number) => Promise<{ close(): void } | undefined>
  readonly openAuthority?: (selector: SubSelector, changed: () => void) => Promise<LaneProjection | undefined>
  readonly openView?: (selector: SubSelector, changed: () => void) => Promise<ViewSubscription | undefined>
}
export type NodeLaneFrame = Extract<Frame, { readonly t: 'welcome' | 'snap' | 'result' | 'pos' | 'chunk' | 'done' | 'fail' | 'end' | 'reset' }>

export interface NodeLane extends Session {
  readonly actor: AuthAdmission['actor']
  readonly frames: AsyncIterableIterator<NodeLaneFrame, void, undefined>
  accept(command: NodeLaneCommand): void
  rightsChanged(): void
  poll(): Promise<NodeLaneFrame | undefined>
  observeReady(listener: () => void): () => void
  read(selector: Selector, signal?: AbortSignal): ReturnType<NativeCommands['read']>
  readOwned(selector: Selector, budget: Budget, signal?: AbortSignal): Promise<ReadReceipt>
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
  readonly empty?: () => void
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
  const delivery = createLaneDelivery(options, subscriptions, registered, remove, () => foreignMetadataBytes);
  const pulls: Pull[] = [];
  const readyListeners = new Set<() => void>();
  const prefix = crypto.randomUUID();
  let sequence = 0;
  let generation = 0;
  let welcome = true;
  let closed = false;
  let reconnecting = false;
  let draining = false;
  let notification = 0;
  let watermark: Position | undefined;
  const foreignOwners = new Map<string, { readonly owner: LaneProducer; readonly positions: Map<string, Position>; bytes: number }>();
  let foreignMetadataBytes = 0;
  let foreignResult: { readonly sub: NodeSubscription; readonly frame: Extract<NodeLaneFrame, { t: 'result' }>; readonly pending: readonly Position[]; index: number } | undefined;
  let deliveredIntake: string | undefined;
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
    releaseForeignSub(sub);
    sub.raw?.close();
    sub.view?.close();
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
    stopShard();
    options.shard?.close();
    admission.signal.removeEventListener('abort', revoked);
    for (const sub of subscriptions.entries.values()) {
      sub.raw?.close();
      sub.view?.close();
      sub.controller.abort(reason);
      subscriptions.remove(sub);
    }
    delivery.close();
    foreignOwners.clear();
    foreignMetadataBytes = 0;
    foreignResult = undefined;
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
    for (const listener of readyListeners) listener();
    readyListeners.clear();
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
  async function prepareSubscription(sub: NodeSubscription): Promise<void> {
    const gen = sub.gen;
    try {
      const changed = () => {
        if (!registered(sub) || sub.gen !== gen) return;
        subscriptions.dirty(sub, false);
        wake();
      };
      const raw = await options.openShard?.(sub.selector, sub.id, sub.gen);
      if (raw !== undefined) {
        if (!registered(sub) || sub.gen !== gen) { raw.close(); return; }
        sub.raw = raw;
        wake();
        return;
      }
      const view = await options.openAuthority?.(sub.selector, changed) ?? await options.openView?.(sub.selector, changed);
      if (!registered(sub) || sub.gen !== gen) { view?.close(); return; }
      sub.view = view;
      sub.ready = true;
      wake();
    } catch (caught) {
      if (registered(sub) && sub.gen === gen) remove(sub, error(caught));
    }
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
      () => { if (registered(sub)) void prepareSubscription(sub); },
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
  function foreign(pos: Position): boolean {
    return pos.instance !== options.stream.cursor().pos.instance;
  }
  function foreignKey(owner: LaneProducer): string {
    return 'req' in owner ? `req:${owner.req}` : `sub:${owner.sub}:${owner.gen}`;
  }
  function foreignWatermark(instance: string): Position | undefined {
    let current: Position | undefined;
    for (const owner of foreignOwners.values()) {
      const position = owner.positions.get(instance);
      if (position !== undefined && (current === undefined || comparePositions(position, current) > 0)) current = position;
    }
    return current;
  }
  function ownForeign(owner: LaneProducer, position: Position): void {
    const key = foreignKey(owner);
    let found = foreignOwners.get(key);
    if (found === undefined) { found = { owner, positions: new Map(), bytes: 0 }; foreignOwners.set(key, found); }
    if (!found.positions.has(position.instance)) {
      let count = 0;
      for (const producer of foreignOwners.values()) count += producer.positions.size;
      if (count >= options.limits().readNodes) throw new KernelError('BUDGET', 'Foreign producer metadata exceeds its allowance');
    }
    const previous = found.positions.get(position.instance);
    const bytes = Buffer.byteLength(serializeKernel({ owner, position }));
    const prior = previous === undefined ? 0 : Buffer.byteLength(serializeKernel({ owner, position: previous }));
    const next = foreignMetadataBytes + bytes - prior;
    if (next + delivery.retainedBytes > options.limits().laneCoverageBytes) throw new KernelError('BUDGET', 'Foreign producer metadata exceeds its byte allowance');
    found.positions.set(position.instance, position);
    found.bytes += bytes - prior;
    foreignMetadataBytes = next;
  }
  function releaseForeignOwner(key: string): void {
    const found = foreignOwners.get(key);
    if (found !== undefined) foreignMetadataBytes -= found.bytes;
    foreignOwners.delete(key);
  }
  function releaseForeignSub(sub: NodeSubscription): void {
    releaseForeignOwner(foreignKey({ sub: sub.id, gen: sub.gen }));
    if (foreignResult?.sub === sub) foreignResult = undefined;
  }
  function forgetMutation(id: string): void {
    releaseForeignOwner(foreignKey({ req: id }));
    mutations.delete(id);
  }
  function nextForeignResult(): NodeLaneFrame | undefined {
    const held = foreignResult;
    if (held === undefined) return undefined;
    try { held.sub.view?.authority?.check(); }
    catch (caught) {
      if (registered(held.sub)) remove(held.sub, error(caught));
      return undefined;
    }
    const owner = { sub: held.sub.id, gen: held.frame.gen };
    while (held.index < held.pending.length) {
      const pos = held.pending[held.index++];
      const previous = foreignWatermark(pos.instance);
      ownForeign(owner, pos);
      if (previous === undefined || comparePositions(pos, previous) > 0) return { t: 'pos', pos, producer: owner, changes: [] };
    }
    foreignResult = undefined;
    return held.frame;
  }
  function uncovered(pos: Position | undefined): boolean {
    return pos !== undefined && !foreign(pos) && (watermark === undefined || comparePositions(pos, watermark) > 0);
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
      releaseForeignSub(sub);
      sub.gen = ++generation;
      sub.initial = true;
      sub.raw?.close();
      sub.raw = undefined;
      sub.view?.invalidate();
      sub.view?.close();
      sub.view = undefined;
      sub.viewVersion = undefined;
      sub.ready = false;
      sub.state = { ...sub.state, range: undefined, next: undefined };
      subscriptions.dirty(sub, true);
      enqueue({ t: 'reset', sub: sub.id, gen: sub.gen });
      void prepareSubscription(sub);
    }
  }
  /** Includes absent selector ranges and inherited rights alongside current copy dependencies. */
  function intersectsSubscription(
    sub: NodeSubscription,
    intersects: (range: ScanRange) => boolean,
  ): boolean {
    const range = 'node' in sub.selector ? { node: sub.selector.node } : { children: sub.selector.children };
    if (intersects(range)) return true;
    if (sub.view?.intersects(intersects)) return true;

    for (const branch of [sub.state.fixed, ...sub.state.roots.values()]) {
      for (const path of branch.paths) if (intersects({ node: path })) return true;
      for (const path of branch.rights) if (intersects({ node: path })) return true;
      for (const range of branch.ranges ?? []) if (intersects(range)) return true;
    }
    return false;
  }
  /** Requires ordinary progress before dirty subscriptions or accepted mutations can complete. */
  function ordinaryNeeded(): boolean {
    if (options.intake() !== deliveredIntake) return true;
    if (
      [...subscriptions.entries.values()].some((sub) => sub.view === undefined && sub.ready && !sub.initial && sub.dirty > 0)
    )
      return true;
    for (const request of mutations.values())
      if (uncovered(request.piece?.value.pos) || uncovered(request.outcome?.pos)) return true;
    return false;
  }
  /** Publishes a snapshot and retains coverage releases at the delivered watermark. */
  async function snapshot(sub: NodeSubscription): Promise<NodeLaneFrame | undefined> {
    try {
      const result = await delivery.snapshot(sub, (_pos, intake) => intake === deliveredIntake);
      if (result !== undefined) {
        for (const id of result.removed) removals.set(id, { op: 'del', id });
        for (const id of result.frame.covered ?? result.frame.list) if (delivery.covers(id)) removals.delete(id);
        watermark ??= result.frame.at.find(pos => !foreign(pos));
        releaseForeignSub(sub);
        for (const pos of result.frame.at) if (foreign(pos)) ownForeign({ sub: sub.id, gen: sub.gen }, pos);
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
    const eligible = [...subscriptions.entries.values()].filter(
      (sub) => sub.view === undefined && sub.ready && !sub.initial,
    );
    try {
      const result = await delivery.flush(eligible, (pos) => {
        if (closed) return false;
        if (watermark !== undefined && comparePositions(pos, watermark) <= 0) {
          if (
            eligible.some(
              (sub) => registered(sub) && sub.ready && !sub.initial && sub.dirty > 0,
            )
          )
            reset();
          return false;
        }
        return true;
      });
      if (result === undefined) return undefined;
      for (const id of removals.keys()) if (delivery.covers(id)) removals.delete(id);
      watermark = result.pos;
      const intake = result.intake === deliveredIntake ? undefined : result.intake;
      deliveredIntake = result.intake;
      return {
        t: 'pos',
        pos: result.pos,
        changes: result.changes,
        ...(intake === undefined ? {} : { intake }),
      };
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
      deliveredIntake = options.intake();
      return {
        t: 'welcome',
        principal: admission.actor.principal,
        intake: deliveredIntake,
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
    if (foreignResult !== undefined) return nextForeignResult();
    for (const sub of subscriptions.entries.values()) {
      try {
        if (sub.ready && sub.initial && (sub.view === undefined || sub.view.ready)) return snapshot(sub);
        if (sub.ready && !sub.initial && sub.view !== undefined && sub.viewVersion !== sub.view.version) {
          const result = await delivery.result(sub);
          if (result === undefined) continue;
          for (const id of result.removed) removals.set(id, { op: 'del', id });
          for (const id of result.frame.covered ?? []) if (delivery.covers(id)) removals.delete(id);
          const pending = result.frame.at.filter(foreign);
          releaseForeignSub(sub);
          foreignResult = { sub, frame: result.frame, pending, index: 0 };
          return nextForeignResult();
        }
      } catch (caught) { if (registered(sub)) remove(sub, error(caught)); }
    }
    for (const request of mutations.values()) {
      const pos = request.piece?.value.pos ?? request.outcome?.pos;
      const covered = pos !== undefined && foreign(pos) ? foreignWatermark(pos.instance) : undefined;
      if (pos !== undefined && foreign(pos) && (covered === undefined || comparePositions(pos, covered) > 0)) {
        const producer = { req: request.id };
        ownForeign(producer, pos);
        return { t: 'pos', pos, producer, changes: [] };
      }
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
        forgetMutation(request.id);
        request.chunks?.end(request.error);
        request.reject(request.error);
        return { t: 'fail', req: request.id, error: request.error };
      }
      if (request.outcome !== undefined) {
        forgetMutation(request.id);
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
    const shard = await options.shard?.poll();
    if (shard !== undefined) {
      if (shard.t === 'snap' || shard.t === 'result' || shard.t === 'reset') {
        const sub = subscriptions.entries.get(shard.sub);
        if (sub === undefined || sub.raw === undefined)
          throw new KernelError('INVALID', 'Shard frame names an unbound subscription');
        if (shard.gen < sub.gen) throw new KernelError('INVALID', 'Shard generation moved backwards');
        sub.gen = shard.gen;
        generation = Math.max(generation, shard.gen);
        if (shard.t !== 'reset') for (const pos of shard.at) ownForeign({ sub: sub.id, gen: sub.gen }, pos);
      } else if (shard.t === 'end') {
        const sub = subscriptions.entries.get(shard.sub);
        if (sub === undefined || sub.raw === undefined)
          throw new KernelError('INVALID', 'Shard end names an unbound subscription');
        remove(sub);
      } else if (shard.t === 'pos' && shard.coverage !== true) {
        if (shard.producer === undefined) throw new KernelError('INVALID', 'Shard position lacks a producer');
        ownForeign(shard.producer, shard.pos);
      }
      return shard;
    }
    if (reconnecting && mutations.size === 0) close();
    return undefined;
  }
  /** Drains only waiting pulls and rechecks notifications received during preparation. */
  function wake(notify = true): void {
    notification++;
    if (notify) for (const listener of readyListeners) listener();
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
            const pull = pulls[0];
            if (pull.empty !== undefined) { pulls.shift(); pull.empty(); continue }
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
        if (observed !== notification) wake(false);
      }
    })();
  }
  const stopShard = options.shard?.observe(() => wake()) ?? (() => {});
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
        wake(false);
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
    else if (event.t === 'commit') {
      for (const change of event.record.quarantine ?? [])
        subscriptions.changed(change.path, true, options.limits().readNodes);
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
    /** Own a direct query slot and cancellation under the accepted lane lifetime. */
  function directRead(selector: Selector, signal?: AbortSignal, accounting?: ReadAccounting) {
      signal?.throwIfAborted();
      touch();
      reserve(id());
      const controller = new AbortController();
      directReads.add(controller);
      return options.commands
        .read(selector, signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]), accounting)
        .finally(() => directReads.delete(controller));
  }
  return {
    actor: admission.actor,
    frames,
    lane: frames,
    close,
    reconnect,
    rightsChanged() { reset(); wake() },
    observeReady(listener) {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    poll() {
      if (closed) return Promise.reject(failure ?? new KernelError('CANCELLED', 'Lane is closed'));
      if (pulls.length >= options.limits().laneRequests)
        return Promise.reject(new KernelError('BUDGET', 'Lane pull limit exceeded'));
      return new Promise((resolve, reject) => {
        pulls.push({ resolve(result) {
          if (result.done) reject(failure ?? new KernelError('CANCELLED', 'Lane is closed'));
          else resolve(result.value);
        }, reject, empty() { resolve(undefined) } });
        wake(false);
      });
    },
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
    read: directRead,
    async readOwned(selector, budget, signal) {
      let cost: ReadQueryCost | undefined;
      try {
        const result = await directRead(selector, signal, { budget, spent: value => { cost = value } });
        if (cost === undefined) throw new KernelError('INVALID', 'Native query cost is absent');
        return { result, cost };
      } catch (error) {
        if (cost === undefined) throw error;
        return { error, cost };
      }
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
      const requestId = id();
      return start((signal) => options.commands.commit(request, signal, requestId), requestId);
    },
    act: (request) => {
      touch();
      const requestId = id();
      return start((signal, deliver) => options.commands.act(request, signal, deliver, requestId), requestId, 'pending');
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
        start((signal) => options.commands.commit(command, signal, command.req), command.req);
      else if (command.t === 'act')
        start((signal, deliver) => options.commands.act(command, signal, deliver, command.req), command.req, 'frames');
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
