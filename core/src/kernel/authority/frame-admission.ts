import { KernelError } from '#errors';
import { applyDelta } from '#kernel/update-ops';
import { serializeKernel } from '#kernel/serialization';
import type {
  Connection,
  Frame,
  LaneChange,
  LaneOwnership,
  Limits,
  NodeCopy,
  Position,
  Request,
} from '#kernel/types';

interface CoveredSubscription {
  readonly generation: number;
  readonly ids: ReadonlySet<string>;
  readonly extra: ReadonlyMap<string, number>;
  readonly rowBytes: number;
  readonly queryBytes: number;
  readonly at: readonly Position[];
}

/** Foreign producers must declare ownership before their copies enter the native client cache. */
export function admitForeignFrames(
  connection: Connection,
  limits: () => Limits,
  cached: (id: string) => NodeCopy | undefined,
): Connection {
  const subscriptions = new Map<string, CoveredSubscription>();
  const copies = new Map<string, number>();
  const requests = new Map<string, Map<string, Position>>();
  let issued = 0,
    retainedBytes = 0;
  let nativeSpace: string | undefined;

  function sequence(id: string): number {
    if (!/^sub:[1-9][0-9]*$/.test(id))
      throw new KernelError('INVALID', 'Foreign subscription identity is invalid');
    const value = Number(id.slice(4));
    if (!Number.isSafeInteger(value))
      throw new KernelError('INVALID', 'Foreign subscription identity exceeds its range');
    return value;
  }
  function retired(id: string): boolean {
    const value = sequence(id);
    if (value > issued) throw new KernelError('INVALID', 'Foreign subscription was not issued');
    return !subscriptions.has(id);
  }
  function identity(copy: NodeCopy): string {
    return 'node' in copy ? copy.node.$id : copy.id;
  }

  function stage(frame: Frame): Frame | undefined {
    const policy = limits();
    let work = 0;
    function charge(count: number): void {
      work += count;
      if (work > policy.exprWork)
        throw new KernelError('BUDGET', 'Foreign frame metadata exceeds its allowance');
    }
    function ids(values: readonly string[]): ReadonlySet<string> {
      charge(values.length);
      for (const id of values) charge(Math.ceil(id.length / 8));
      if (values.length > policy.readNodes)
        throw new KernelError('BUDGET', 'Foreign coverage exceeds its node allowance');
      const result = new Set(values);
      if (result.size !== values.length)
        throw new KernelError('INVALID', 'Foreign coverage contains duplicate identities');
      return result;
    }
    function positionBytes(positions: readonly Position[]): number {
      let bytes = 0;
      for (const position of positions) {
        charge(1 + Math.ceil(position.instance.length / 8));
        if (Buffer.byteLength(position.instance) > policy.laneCoverageBytes)
          throw new KernelError('BUDGET', 'Foreign position metadata exceeds its byte allowance');
        bytes += Buffer.byteLength(serializeKernel(position));
      }
      return bytes;
    }
    if (frame.t === 'snap' || frame.t === 'result') {
      charge(frame.at.length);
      if (frame.at.length > policy.readNodes)
        throw new KernelError('BUDGET', 'Foreign position metadata exceeds its allowance');
      const spaces = new Set<string>();
      for (const position of frame.at) {
        charge(Math.ceil(position.instance.length / 8));
        if (spaces.has(position.instance))
          throw new KernelError('INVALID', 'Foreign position space is duplicated');
        spaces.add(position.instance);
      }
      if (frame.foreign !== undefined)
        for (const space of ids(frame.foreign)) {
          if (!spaces.has(space))
            throw new KernelError('INVALID', 'Foreign producer position is absent');
        }
      const foreign = new Set(frame.foreign);
      for (const position of frame.at)
        if (!foreign.has(position.instance)) {
          if (nativeSpace !== undefined && nativeSpace !== position.instance)
            throw new KernelError(
              'INVALID',
              'Foreign native position space changed without an owner',
            );
          nativeSpace = position.instance;
        }
    } else if (frame.t === 'pos') {
      charge(Math.ceil(frame.pos.instance.length / 8));
      positionBytes([frame.pos]);
      if (frame.coverage !== true && frame.producer === undefined) {
        if (nativeSpace !== undefined && nativeSpace !== frame.pos.instance)
          throw new KernelError(
            'INVALID',
            'Foreign native position space changed without an owner',
          );
        nativeSpace = frame.pos.instance;
      }
      if (frame.coverage !== true && frame.producer !== undefined) {
        const owner = frame.producer;
        charge(Math.ceil(('req' in owner ? owner.req : owner.sub).length / 8));
        if ('req' in owner) {
          const request = requests.get(owner.req);
          if (request === undefined)
            throw new KernelError('INVALID', 'Foreign position has no request owner');
          if (!request.has(frame.pos.instance) && request.size >= policy.readNodes)
            throw new KernelError(
              'BUDGET',
              'Foreign request position metadata exceeds its node allowance',
            );
          request.set(frame.pos.instance, frame.pos);
        } else {
          const sub = subscriptions.get(owner.sub);
          if (sub === undefined || sub.generation !== owner.gen)
            throw new KernelError(
              'INVALID',
              'Foreign position has no subscription generation owner',
            );
          const at = [frame.pos];
          for (const position of sub.at)
            if (position.instance !== frame.pos.instance) at.push(position);
          if (at.length > policy.readNodes)
            throw new KernelError('BUDGET', 'Foreign position metadata exceeds its node allowance');
          subscriptions.set(owner.sub, { ...sub, at });
        }
      }
    }
    function queryCost(ownership: LaneOwnership | undefined): number {
      if (ownership === undefined) return 0;
      charge(ownership.roots.length);
      let bytes = 0;
      for (const root of ownership.roots)
        if (root.query !== undefined) {
          const size = Buffer.byteLength(serializeKernel(root.query));
          charge(Math.ceil(size / 8));
          bytes += size;
        }
      return bytes;
    }
    function replace(
      sub: string,
      generation: number,
      covered: readonly string[],
      queryBytes: number,
      at: readonly Position[],
    ): void {
      const current = subscriptions.get(sub);
      if (current === undefined)
        throw new KernelError('INVALID', 'Foreign coverage has no subscription owner');
      if (generation < current.generation)
        throw new KernelError('INVALID', 'Foreign coverage generation regressed');
      const selected = ids(covered);
      const extra = new Map<string, number>();
      charge(current.extra.size);
      for (const [id, bytes] of current.extra) if (selected.has(id)) extra.set(id, bytes);
      subscriptions.set(sub, {
        generation,
        ids: selected,
        extra,
        rowBytes: current.rowBytes,
        queryBytes,
        at,
      });
    }
    const obsolete = new Set<string>();
    const retainedChanges = new Set<LaneChange>();
    if (frame.t === 'snap' || frame.t === 'result') {
      if (retired(frame.sub)) return undefined;
      replace(
        frame.sub,
        frame.gen,
        frame.covered ?? frame.copies.map(identity),
        queryCost(frame.ownership),
        frame.at,
      );
      const current = subscriptions.get(frame.sub)!;
      const extra = frame.t === 'snap' ? new Map<string, number>() : new Map(current.extra);
      charge(
        (frame.computed?.length ?? 0) +
          (frame.viewErrors?.length ?? 0) +
          frame.copies.length +
          (frame.rows?.length ?? 0),
      );
      for (const copy of frame.copies) extra.delete(identity(copy));
      for (const value of frame.computed ?? []) {
        if (!current.ids.has(value.$id))
          throw new KernelError('INVALID', 'Foreign computed node has no coverage owner');
        const bytes = Buffer.byteLength(serializeKernel(value));
        if (bytes > policy.nodeBytes)
          throw new KernelError('BUDGET', 'Foreign computed node exceeds its allowance');
        extra.set(value.$id, bytes);
      }
      for (const value of frame.viewErrors ?? []) {
        if (!current.ids.has(value.id))
          throw new KernelError('INVALID', 'Foreign error copy has no coverage owner');
        const bytes = Buffer.byteLength(serializeKernel(value));
        if (bytes > policy.nodeBytes)
          throw new KernelError('BUDGET', 'Foreign error copy exceeds its allowance');
        extra.set(value.id, bytes);
      }
      const rowBytes =
        frame.rows === undefined
          ? frame.t === 'snap'
            ? 0
            : current.rowBytes
          : Buffer.byteLength(serializeKernel(frame.rows));
      subscriptions.set(frame.sub, { ...current, extra, rowBytes });
    } else if (frame.t === 'reset') {
      if (retired(frame.sub)) return undefined;
      replace(frame.sub, frame.gen, [], 0, []);
      const current = subscriptions.get(frame.sub)!;
      subscriptions.set(frame.sub, { ...current, rowBytes: 0 });
    } else if (frame.t === 'done' || frame.t === 'fail') {
      if (frame.req === undefined) requests.clear();
      else requests.delete(frame.req);
    } else if (frame.t === 'end') {
      if (retired(frame.sub)) return undefined;
      subscriptions.delete(frame.sub);
    } else if (frame.t === 'pos') {
      charge(frame.changes.length);
      for (const change of frame.changes)
        if (change.op === 'list') {
          if (retired(change.sub)) {
            if (change.covered === undefined)
              throw new KernelError('UNAVAILABLE', 'Retired foreign coverage is absent');
            for (const id of ids(change.covered)) obsolete.add(id);
            continue;
          }
          if (change.covered === undefined)
            throw new KernelError('UNAVAILABLE', 'Foreign membership coverage is absent');
          const current = subscriptions.get(change.sub)!;
          const at = [frame.pos];
          for (const position of current.at)
            if (position.instance !== frame.pos.instance) at.push(position);
          replace(change.sub, change.gen, change.covered, queryCost(change.ownership), at);
        }
    }
    const covered = new Set<string>();
    for (const sub of subscriptions.values()) {
      charge(sub.ids.size);
      for (const id of sub.ids) covered.add(id);
    }
    if (covered.size > policy.readNodes)
      throw new KernelError('BUDGET', 'Foreign lane coverage exceeds its node allowance');
    function put(copy: NodeCopy): void {
      const id = identity(copy);
      if (!covered.has(id))
        throw new KernelError('INVALID', 'Foreign copy has no declared coverage owner');
      const bytes = Buffer.byteLength(serializeKernel(copy));
      if (bytes > policy.nodeBytes)
        throw new KernelError('BUDGET', 'Foreign copy exceeds its node allowance');
      retainedBytes += bytes - (copies.get(id) ?? 0);
      copies.set(id, bytes);
    }
    if (frame.t === 'snap' || frame.t === 'result') {
      charge(frame.copies.length);
      for (const copy of frame.copies) put(copy);
    } else if (frame.t === 'pos')
      for (const change of frame.changes) {
        if (change.op === 'list' && retired(change.sub)) continue;
        const id =
          change.op === 'put'
            ? identity(change.copy)
            : change.op === 'list'
              ? undefined
              : change.id;
        if (
          id !== undefined &&
          !covered.has(id) &&
          change.op !== 'del' &&
          (obsolete.has(id) || copies.has(id))
        )
          continue;
        retainedChanges.add(change);
        if (change.op === 'put') put(change.copy);
        else if (change.op === 'del') {
          retainedBytes -= copies.get(change.id) ?? 0;
          copies.delete(change.id);
        } else if (change.op === 'patch') {
          if (!covered.has(change.id))
            throw new KernelError('INVALID', 'Foreign patch has no declared coverage owner');
          const before = cached(change.id);
          if (before === undefined || !('node' in before) || before.ver !== change.base)
            throw new KernelError('CONFLICT', 'Foreign patch differs from its retained base');
          const deltaBytes = Buffer.byteLength(serializeKernel(change.delta));
          charge(Math.ceil(deltaBytes / 8));
          if ((copies.get(change.id) ?? 0) + deltaBytes > policy.readBytes)
            throw new KernelError('BUDGET', 'Foreign patch materialization exceeds its allowance');
          put({ node: applyDelta(before.node, change.delta), bits: change.bits, ver: change.ver });
        }
      }
    let heldBytes = 0;
    for (const request of requests.values())
      for (const position of request.values()) heldBytes += positionBytes([position]);
    for (const id of covered) heldBytes += copies.get(id) ?? 0;
    for (const sub of subscriptions.values()) {
      heldBytes += sub.rowBytes + sub.queryBytes + positionBytes(sub.at);
      for (const bytes of sub.extra.values()) heldBytes += bytes;
    }
    if (
      heldBytes > policy.laneCoverageBytes ||
      copies.size > policy.readNodes * 2 ||
      retainedBytes > policy.laneCoverageBytes * 2
    )
      throw new KernelError('BUDGET', 'Foreign retained copies exceed their coverage allowance');
    if (frame.t !== 'pos') return frame;
    if (frame.coverage === true)
      return { ...frame, changes: frame.changes.filter((change) => retainedChanges.has(change)) };
    return { ...frame, changes: frame.changes.filter((change) => retainedChanges.has(change)) };
  }
  return {
    send(request: Request) {
      if (request.t === 'read' || request.t === 'act' || request.t === 'commit') {
        if (requests.size >= limits().laneRequests)
          throw new KernelError('BUDGET', 'Foreign unfinished-request allowance exceeded');
        requests.set(request.req, new Map());
      }
      if (request.t === 'sub') {
        if (subscriptions.size >= limits().subsPerLane)
          throw new KernelError('BUDGET', 'Foreign subscription allowance exceeded');
        const value = sequence(request.sub);
        if (value !== issued + 1)
          throw new KernelError('INVALID', 'Foreign subscription identity was reused');
        issued = value;
        subscriptions.set(request.sub, {
          generation: 0,
          ids: new Set(),
          extra: new Map(),
          rowBytes: 0,
          queryBytes: 0,
          at: [],
        });
      } else if (request.t === 'unsub') subscriptions.delete(request.sub);
      connection.send(request);
    },
    frames: {
      async *[Symbol.asyncIterator]() {
        for await (const frame of connection.frames) {
          const accepted = stage(frame);
          if (accepted !== undefined) yield accepted;
        }
      },
    },
  };
}
