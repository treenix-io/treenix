import { KernelError } from '#errors';
import type { NodeLaneImage, NodeLaneOptions, NodeLaneRead } from '#kernel/lane';
import { compareScanKeys, type ScanKey } from '#kernel/store/scan';
import {
  subscriptionBranch,
  subscriptionRoot,
  subscriptionState,
  type NodeSubscription,
  type SubscriptionState,
  type createSubscriptions,
} from '#kernel/subscription';
import { computeDelta } from '#kernel/update-ops';
import type { Frame, LaneChange, NodeCopy, NodeId, Path, Position, Sort } from '#kernel/types';

interface Coverage {
  count: number;
  bytes: number;
  readonly release: () => void;
}
interface Stage {
  readonly sub: NodeSubscription;
  readonly gen: number;
  readonly stamp: number;
  readonly force: boolean;
  readonly changes: ReadonlyMap<Path, { count: number; force: boolean }>;
  readonly keys: Map<Path, ScanKey>;
  state: SubscriptionState;
}
/** Returns the shared identity of either a projected node or an error copy. */
const copyId = (copy: NodeCopy): NodeId => ('node' in copy ? copy.node.$id : copy.id);
/** Locates either a projected node or an error copy. */
const copyPath = (copy: NodeCopy): Path => ('node' in copy ? copy.node.$path : copy.path);
/** Returns direct list members without include-only coverage. */
const members = (state: SubscriptionState): NodeId[] =>
  [...state.roots.values()].flatMap((root) => (root.member === undefined ? [] : [root.member]));
/** Compares coverage membership independently of list order. */
const sameIds = (a: ReadonlySet<NodeId>, b: ReadonlySet<NodeId>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id));
/** Uses the selector sort or native child default for eviction. */
const sortOf = (sub: NodeSubscription): Sort =>
  'children' in sub.selector ? (sub.selector.sort ?? [['$order', 1]]) : [];

/** Shares cache pins across subscriptions and stages delivery inside one read barrier. */
export function createLaneDelivery(
  options: Pick<NodeLaneOptions, 'read' | 'limits' | 'cache'>,
  subscriptions: ReturnType<typeof createSubscriptions>,
  registered: (sub: NodeSubscription) => boolean,
  remove: (sub: NodeSubscription, reason: KernelError) => void,
) {
  const coverage = new Map<NodeId, Coverage>();
  const claims =
    options.cache === undefined || options.cache.length === 0
      ? undefined
      : new Map(options.cache.map(claim => [claim.id, claim.ver]));
  /** Releases one subscription while retaining IDs covered elsewhere. */
  function release(sub: NodeSubscription): LaneChange[] {
    const changes: LaneChange[] = [];
    if (sub.state.covered.size === 0) return changes;
    for (const id of sub.state.covered) {
      const held = coverage.get(id)!;
      if (--held.count === 0) {
        held.release();
        coverage.delete(id);
        changes.push({ op: 'del', id });
      }
    }
    changes.push({
      op: 'list',
      sub: sub.id,
      gen: sub.gen,
      diff: members(sub.state).map((remove) => ({ remove })),
      covered: [],
    });
    sub.state = subscriptionState(
      new Map(),
      { covered: [], paths: [], rights: [] },
      sub.state.range,
    );
    return changes;
  }
  /** Estimates lane coverage after all live staged changes are applied together. */
  function estimate(stages: readonly Stage[], images: ReadonlyMap<NodeId, NodeLaneImage>) {
    const counts = new Map([...coverage].map(([id, held]) => [id, held.count]));
    for (const stage of stages)
      if (registered(stage.sub) && stage.sub.gen === stage.gen) {
        for (const id of stage.sub.state.covered) counts.set(id, counts.get(id)! - 1);
        for (const id of stage.state.covered) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    let bytes = 0;
    for (const [id, count] of counts)
      if (count > 0) bytes += images.get(id)?.bytes ?? coverage.get(id)!.bytes;
    return { counts, bytes };
  }
  /** Evicts the last unique member and preserves a monotonically bounded range. */
  async function narrow(
    stage: Stage,
    source: NodeLaneRead,
    counts: ReadonlyMap<NodeId, number>,
  ): Promise<boolean> {
    const sort = sortOf(stage.sub);
    const rows: { path: Path; key: ScanKey; id: NodeId }[] = [];
    for (const root of stage.state.roots.values())
      if (root.member !== undefined) {
        let key = stage.keys.get(root.path);
        if (key === undefined) {
          const found = await source.key(root.path, sort);
          if (found === null)
            throw new KernelError('CONFLICT', 'Window member changed during eviction');
          key = found;
          stage.keys.set(root.path, key);
        }
        rows.push({ path: root.path, key, id: root.member });
      }
    source.check();
    rows.sort((a, b) => compareScanKeys(a.key, b.key, sort));
    let index = rows.length - 1;
    while (index >= 0 && counts.get(rows[index].id)! > 1) index--;
    if (index < 0) return false;
    const [last] = rows.splice(index, 1);
    const roots = new Map(stage.state.roots);
    roots.delete(last.path);
    const upper = rows.at(-1)?.key ?? null;
    stage.state = subscriptionState(
      roots,
      stage.state.fixed,
      { upper },
      upper === null ? undefined : source.cursor(stage.sub.selector, upper),
      stage.state.domains,
    );
    return true;
  }
  /** Stages canonical projections, coverage limits and pins before the read barrier releases. */
  async function prepare(subs: readonly NodeSubscription[], initial: boolean) {
    const held = new Map<NodeId, () => void>();
    try {
      const result = await options.read(async (source) => {
        const images = new Map<NodeId, NodeLaneImage>();
        const reusable =
          initial && claims !== undefined && claims.size > 0
            ? new Set<NodeId>()
            : undefined;
        const stages: Stage[] = [];
        let interrupted = false;
        /** Queues a refusal before any staged data can be published. */
        function deny(stage: Stage, reason: KernelError): void {
          interrupted = true;
          remove(stage.sub, reason);
        }
        for (const sub of subs) {
          const gen = sub.gen;
          const stamp = sub.stamp;
          const force = sub.forcePut;
          let candidates: readonly Path[] | undefined;
          if (!initial) {
            if ('node' in sub.selector) candidates = [sub.path];
            else if (!sub.full) candidates = [...sub.candidates];
          }
          const selection = await source.select(
            sub.selector,
            candidates,
            initial ? sub.state.range : (sub.state.range ?? {}),
          );
          source.check();
          if (!registered(sub) || sub.gen !== gen) continue;
          const roots =
            candidates === undefined
              ? new Map<Path, ReturnType<typeof subscriptionRoot>>()
              : new Map(sub.state.roots);
          const keys = new Map<Path, ScanKey>();
          for (const root of selection.roots) {
            if (root.member === undefined) roots.delete(root.path);
            else {
              roots.set(root.path, subscriptionRoot(root));
              keys.set(root.path, root.member.key);
            }
          }
          let range = sub.state.range;
          if (
            initial &&
            range === undefined &&
            'children' in sub.selector &&
            sub.selector.window !== undefined
          )
            range = { upper: selection.roots.at(-1)?.member?.key };
          const state = subscriptionState(
            roots,
            subscriptionBranch(selection.fixedIncludes),
            range,
            initial ? selection.next : sub.state.next,
            selection.reads.dependencies?.flatMap(input => input.kind === 'epoch' ? [input.key] : []) ?? [],
          );
          stages.push({ sub, gen, stamp, force, keys, state, changes: new Map(sub.changes) });
          for (const image of selection.images) {
            const id = copyId(image.copy);
            images.set(id, image);
            if (
              reusable !== undefined &&
              'node' in image.copy &&
              claims?.get(id) === image.copy.ver &&
              source.claimable(copyPath(image.copy))
            )
              reusable.add(id);
          }
        }
        for (let i = 0; i < stages.length; ) {
          const stage = stages[i];
          const window = 'children' in stage.sub.selector ? stage.sub.selector.window : undefined;
          if (window?.evict === true && members(stage.state).length > window.limit) {
            if (await narrow(stage, source, estimate(stages, images).counts)) continue;
            deny(stage, new KernelError('BUDGET', 'Window cannot release shared coverage'));
            stages.splice(i, 1);
            continue;
          }
          i++;
        }
        // Error copies are shared too; their sort fields must serve every covering selector.
        const staged = new Map(stages.map((stage) => [stage.sub, stage.state]));
        const counts = estimate(stages, images).counts;
        for (const [id, image] of images)
          if ('error' in image.copy && (counts.get(id) ?? 0) > 0) {
            const fields = new Set<string>();
            for (const sub of subscriptions.entries.values())
              if ((staged.get(sub) ?? sub.state).covered.has(id))
                for (const [field] of sortOf(sub)) fields.add(field);
            const sort: Sort = [...fields].map((field) => [field, 1]);
            const combined = await source.image(copyPath(image.copy), sort);
            if (combined === null)
              throw new KernelError('CONFLICT', 'Error copy disappeared during delivery');
            images.set(id, combined);
          }
        let estimated = estimate(stages, images);
        while (estimated.bytes > options.limits().laneCoverageBytes) {
          const expanded = new Set<NodeId>();
          for (const [id, image] of images)
            if (!coverage.has(id) || image.bytes > coverage.get(id)!.bytes) expanded.add(id);
          const charged = stages.find((stage) =>
            [...stage.state.covered].some((id) => expanded.has(id)),
          );
          if (charged === undefined)
            throw new KernelError('BUDGET', 'Lane coverage budget exceeded');
          const window =
            'children' in charged.sub.selector ? charged.sub.selector.window : undefined;
          if (window?.evict !== true || !(await narrow(charged, source, estimated.counts))) {
            deny(charged, new KernelError('BUDGET', 'Lane coverage budget exceeded'));
            stages.splice(stages.indexOf(charged), 1);
          }
          estimated = estimate(stages, images);
        }
        source.check();
        for (const stage of stages) subscriptions.capture(stage.sub, stage.state);
        for (const [id, image] of images)
          if ((estimated.counts.get(id) ?? 0) > 0) held.set(id, image.retain());
        return { stages, images, reusable, pos: source.pos, interrupted };
      }, subs.map(sub => sub.selector));
      return { ...result, held };
    } catch (error) {
      for (const release of held.values()) release();
      throw error;
    }
  }
  /** Reconciles shared coverage atomically before forming copy and list differences. */
  function apply(result: Awaited<ReturnType<typeof prepare>>, initial: boolean) {
    const stages = result.stages.filter(
      (stage) => registered(stage.sub) && stage.gen === stage.sub.gen,
    );
    const estimated = estimate(stages, result.images);
    const changes: LaneChange[] = [];
    const lists: LaneChange[] = [];
    const previous = new Set(coverage.keys());
    const removed: NodeId[] = [];
    for (const [id, count] of estimated.counts) {
      const prior = coverage.get(id);
      if (count === 0) {
        if (prior !== undefined) {
          prior.release();
          coverage.delete(id);
          changes.push({ op: 'del', id });
          removed.push(id);
        }
      } else if (prior === undefined) {
        const release = result.held.get(id);
        const image = result.images.get(id);
        if (release === undefined || image === undefined)
          throw new KernelError('INVALID', 'Coverage pin is missing');
        coverage.set(id, { count, bytes: image.bytes, release });
        result.held.delete(id);
      } else {
        prior.count = count;
        prior.bytes = result.images.get(id)?.bytes ?? prior.bytes;
      }
    }
    for (const stage of stages) {
      const before = stage.sub.state;
      const prior = new Set(members(before));
      const current = new Set(members(stage.state));
      const diff: Extract<LaneChange, { op: 'list' }>['diff'] = [
        ...[...prior].filter((id) => !current.has(id)).map((remove) => ({ remove })),
        ...[...current].filter((id) => !prior.has(id)).map((add) => ({ add })),
      ];
      if (
        !initial &&
        (diff.length > 0 ||
          !sameIds(before.covered, stage.state.covered) ||
          before.next !== stage.state.next)
      )
        lists.push({
          op: 'list',
          sub: stage.sub.id,
          gen: stage.gen,
          diff,
          covered: [...stage.state.covered],
          next: stage.state.next,
        });
      subscriptions.install(stage.sub, stage.state);
      for (const id of stage.state.covered) claims?.delete(id);
      stage.sub.initial = false;
      if (stage.stamp === stage.sub.stamp) {
        stage.sub.dirty = 0;
        stage.sub.forcePut = false;
        stage.sub.full = false;
        stage.sub.candidates.clear();
        stage.sub.changes.clear();
      } else stage.sub.dirty = 2;
    }
    for (const [id, image] of result.images) {
      if (!coverage.has(id)) continue;
      let count = 0;
      let force = !previous.has(id);
      for (const stage of stages)
        if (stage.state.covered.has(id)) {
          const event = stage.changes.get(copyPath(image.copy));
          count = Math.max(count, event?.count ?? 0);
          force ||= stage.force || event?.force === true;
        }
      if (!initial && (force || count > 0 || 'error' in image.copy)) {
        const { copy, before } = image;
        if (
          count === 1 &&
          !force &&
          before !== undefined &&
          before !== null &&
          'node' in before &&
          'node' in copy &&
          before.bits === copy.bits
        )
          changes.push({
            op: 'patch',
            id,
            base: before.ver,
            delta: computeDelta(before.node, copy.node),
            ver: copy.ver,
            bits: copy.bits,
          });
        else changes.push({ op: 'put', copy });
      }
    }
    changes.push(...lists);
    return { changes, removed };
  }
  return {
    release,
    covers: (id: NodeId) => coverage.has(id),
    /** Releases every shared cache pin owned by the lane. */
    close() {
      for (const held of coverage.values()) held.release();
      coverage.clear();
      claims?.clear();
    },
    /** Publishes current membership and exposes released IDs for coverage controls. */
    async snapshot(sub: NodeSubscription) {
      const result = await prepare([sub], true);
      try {
        const stage = result.stages[0];
        if (stage === undefined || !registered(sub) || sub.gen !== stage.gen) return undefined;
        const copies = [...result.images].flatMap(([id, image]) =>
          stage.state.covered.has(id) &&
          result.reusable?.has(id) !== true &&
          (!coverage.has(id) || stage.force || 'error' in image.copy)
            ? [image.copy]
            : [],
        );
        const { removed } = apply(result, true);
        const frame: Extract<Frame, { t: 'snap' }> = {
          t: 'snap',
          sub: sub.id,
          gen: stage.gen,
          list: members(stage.state),
          covered: [...stage.state.covered],
          copies,
          at: [result.pos],
          next: stage.state.next,
        };
        return { frame, removed };
      } finally {
        for (const release of result.held.values()) release();
      }
    },
    /** Publishes prepared differences only when their ordinary position can advance. */
    async flush(subs: readonly NodeSubscription[], after: (pos: Position) => boolean) {
      const result = await prepare(subs, false);
      try {
        if (result.interrupted || !after(result.pos)) return undefined;
        return { pos: result.pos, changes: apply(result, false).changes };
      } finally {
        for (const release of result.held.values()) release();
      }
    },
  };
}
