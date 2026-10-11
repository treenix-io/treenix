import { serializeKernel, kernelErrorData } from '#kernel/serialization'
import { KernelError } from '#errors';
import { comparePositions } from '#kernel/position';
import { createHash } from 'node:crypto';
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
import { stableJson } from '#util/stable-json';
import type { ComputedNode, ErrorCopy, Frame, LaneChange, NodeCopy, NodeId, Path, Position, Row, Sort, ViewOwner } from '#kernel/types';

interface Coverage {
  count: number;
  bytes: number;
  readonly release: () => void;
  ver: string;
  copy: NodeCopy;
  position?: Position;
}
interface ViewExtras {
  readonly viewOwner?: ViewOwner;
  readonly computed?: readonly ComputedNode[];
  readonly viewErrors?: readonly ErrorCopy[];
  readonly rows?: readonly Row[];
}
interface Stage {
  readonly viewOwner?: ViewOwner;
  readonly sub: NodeSubscription;
  readonly gen: number;
  readonly stamp: number;
  readonly force: boolean;
  readonly changes: ReadonlyMap<Path, { count: number; force: boolean }>;
  readonly keys: Map<Path, ScanKey>;
  state: SubscriptionState;
  computed?: readonly ComputedNode[];
  viewErrors?: readonly ErrorCopy[];
  readonly rows?: readonly Row[];
  readonly at?: readonly Position[];
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
const version = (value: unknown): string => createHash('sha256').update(value === undefined ? 'undefined' : stableJson(value)).digest('hex');
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
  const extras = new Map<NodeSubscription, ViewExtras>();
  const versions = new Map<NodeSubscription, Map<NodeId, string>>();
  function currentImage(image: NodeLaneImage, prior: Coverage | undefined): boolean {
    return prior?.position === undefined || image.position === undefined
      || comparePositions(image.position, prior.position) >= 0;
  }
  function extraCost(stages: readonly Stage[]): number {
    const current = new Map(extras);
    for (const stage of stages) if (registered(stage.sub))
      current.set(stage.sub, { computed: stage.computed, viewErrors: stage.viewErrors, rows: stage.rows, viewOwner: stage.viewOwner });
    const computed = new Map<string, ComputedNode>();
    let bytes = 0;
    for (const [sub, extra] of current) {
      if (extra.viewOwner !== undefined) bytes += Buffer.byteLength(serializeKernel(extra.viewOwner));
      if (extra.rows !== undefined) bytes += Buffer.byteLength(serializeKernel(extra.rows));
      if (extra.viewErrors !== undefined) bytes += Buffer.byteLength(serializeKernel(extra.viewErrors));
      for (const node of extra.computed ?? []) computed.set(`${sub.view!.key}:${node.$id}`, node);
    }
    for (const node of computed.values()) bytes += Buffer.byteLength(serializeKernel(node));
    return bytes;
  }
  const claims =
    options.cache === undefined || options.cache.length === 0
      ? undefined
      : new Map(options.cache.map(claim => [claim.id, claim.ver]));
  /** Releases one subscription while retaining IDs covered elsewhere. */
  function release(sub: NodeSubscription): LaneChange[] {
    extras.delete(sub);
    versions.delete(sub);
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
      if (count > 0) {
        const image = images.get(id);
        const prior = coverage.get(id);
        bytes += image !== undefined && currentImage(image, prior) ? image.bytes : prior!.bytes;
      }
    return { counts, bytes };
  }
  /** Evicts the last unique member and preserves a monotonically bounded range. */
  async function narrow(
    stage: Stage,
    source: NodeLaneRead,
    counts: ReadonlyMap<NodeId, number>,
    stages: readonly Stage[],
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
    const computedCounts = new Map<NodeId, number>();
    if (stage.computed !== undefined) {
      const current = new Map(extras);
      for (const staged of stages) current.set(staged.sub, { computed: staged.computed, viewErrors: staged.viewErrors, rows: staged.rows, viewOwner: staged.viewOwner });
      for (const [sub, extra] of current) if (sub.view?.key === stage.sub.view?.key)
        for (const node of extra.computed ?? []) computedCounts.set(node.$id, (computedCounts.get(node.$id) ?? 0) + 1);
    }
    let index = rows.length - 1;
    while (index >= 0 && (stage.viewErrors?.some(copy => copy.id === rows[index].id) !== true)
      && (stage.computed === undefined ? counts : computedCounts).get(rows[index].id)! > 1) index--;
    if (index < 0) return false;
    const [last] = rows.splice(index, 1);
    const roots = new Map(stage.state.roots);
    roots.delete(last.path);
    const upper = rows.at(-1)?.key ?? null;
    stage.state = subscriptionState(
      roots,
      stage.state.fixed,
      { upper },
      upper === null ? undefined : stage.sub.view?.cursor(upper) ?? source.cursor(stage.sub.selector, upper),
      stage.state.domains,
    );
    if (stage.computed !== undefined) {
      const remaining = new Set(stage.state.fixed.computed);
      for (const root of roots.values()) for (const id of root.computed ?? []) remaining.add(id);
      stage.computed = stage.computed.filter(node => remaining.has(node.$id));
    }
    if (stage.viewErrors !== undefined) {
      const remaining = new Set(stage.state.fixed.viewErrors);
      for (const root of roots.values()) for (const id of root.viewErrors ?? []) remaining.add(id);
      stage.viewErrors = stage.viewErrors.filter(copy => remaining.has(copy.id));
    }
    return true;
  }
  /** Stages canonical projections, coverage limits and pins before the read barrier releases. */
  async function prepare(
    subs: readonly NodeSubscription[],
    initial: boolean,
    ready?: (pos: Position, intake: string) => boolean,
  ) {
    const held = new Map<NodeId, () => void>();
    try {
      const result = await options.read(async (source) => {
        if (ready?.(source.pos, source.intake) === false) return undefined;
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
          if (
            !initial &&
            (!registered(sub) || !sub.ready || sub.initial || sub.dirty === 0)
          )
            continue;
          const gen = sub.gen;
          const stamp = sub.stamp;
          const force = sub.forcePut;
          await source.authorizeView?.(sub.selector);
          let candidates: readonly Path[] | undefined;
          if (!initial) {
            if ('node' in sub.selector) candidates = [sub.path];
            else if (!sub.full) candidates = [...sub.candidates];
          }
          const selection = sub.view === undefined ? await source.select(
            sub.selector,
            candidates,
            initial ? sub.state.range : (sub.state.range ?? {}),
          ) : sub.view.select(initial ? sub.state.range : (sub.state.range ?? {}));
          if (selection === undefined) continue;
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
          stages.push({ sub, gen, stamp, force, keys, state, changes: new Map(sub.changes),
            computed: selection.computed, viewErrors: selection.viewErrors, rows: selection.rows, at: selection.at, viewOwner: selection.viewOwner });
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
            if (await narrow(stage, source, estimate(stages, images).counts, stages)) continue;
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
        while (estimated.bytes + extraCost(stages) > options.limits().laneCoverageBytes) {
          const expanded = new Set<NodeId>();
          for (const [id, image] of images)
            if (!coverage.has(id) || image.bytes > coverage.get(id)!.bytes) expanded.add(id);
          const charged = stages.find((stage) =>
            [...stage.state.covered].some((id) => expanded.has(id)),
          ) ?? stages.find(stage => stage.sub.view !== undefined
            && Buffer.byteLength(serializeKernel({ computed: stage.computed, viewErrors: stage.viewErrors, rows: stage.rows }))
              > Buffer.byteLength(serializeKernel(extras.get(stage.sub) ?? {})));
          if (charged === undefined)
            throw new KernelError('BUDGET', 'Lane coverage budget exceeded');
          const window =
            'children' in charged.sub.selector ? charged.sub.selector.window : undefined;
          if (window?.evict !== true || !(await narrow(charged, source, estimated.counts, stages))) {
            deny(charged, new KernelError('BUDGET', 'Lane coverage budget exceeded'));
            stages.splice(stages.indexOf(charged), 1);
          }
          estimated = estimate(stages, images);
        }
        source.check();
        for (const stage of stages) subscriptions.capture(stage.sub, stage.state);
        for (const [id, image] of images)
          if ((estimated.counts.get(id) ?? 0) > 0) held.set(id, image.retain());
        return { stages, images, reusable, pos: source.pos, intake: source.intake, interrupted };
      }, subs.map(sub => sub.selector));
      return result === undefined ? undefined : { ...result, held };
    } catch (error) {
      for (const release of held.values()) release();
      throw error;
    }
  }
  /** Reconciles shared coverage atomically before forming copy and list differences. */
  function apply(result: NonNullable<Awaited<ReturnType<typeof prepare>>>, initial: boolean) {
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
        coverage.set(id, { count, bytes: image.bytes, release, ver: image.copy.ver, copy: image.copy, position: image.position });
        result.held.delete(id);
      } else {
        prior.count = count;
        const image = result.images.get(id);
        if (image !== undefined && currentImage(image, prior)) {
          prior.bytes = image.bytes;
          prior.ver = image.copy.ver;
          prior.copy = image.copy;
          prior.position = image.position;
        }
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
      extras.set(stage.sub, { computed: stage.computed, viewErrors: stage.viewErrors, rows: stage.rows, viewOwner: stage.viewOwner });
      for (const id of stage.state.covered) claims?.delete(id);
      stage.sub.initial = false;
      if (stage.sub.view !== undefined) stage.sub.viewVersion = stage.sub.view.version;
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
      if (!currentImage(image, coverage.get(id))) continue;
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
      extras.clear();
      versions.clear();
      claims?.clear();
    },
    /** Publishes current membership and exposes released IDs for coverage controls. */
    async snapshot(sub: NodeSubscription, ready: (pos: Position, intake: string) => boolean) {
      const result = await prepare([sub], true, ready);
      if (result === undefined) return undefined;
      try {
        const stage = result.stages[0];
        if (stage === undefined || !registered(sub) || sub.gen !== stage.gen) return undefined;
        const copies = [...result.images].flatMap(([id, image]) =>
          stage.state.covered.has(id) &&
          result.reusable?.has(id) !== true &&
          currentImage(image, coverage.get(id)) &&
          (!coverage.has(id) || stage.force || 'error' in image.copy)
            ? [image.copy]
            : [],
        );
        const { removed } = apply(result, true);
        versions.set(sub, new Map([
          ...stage.computed?.map(node => [node.$id, version(node)] as const) ?? [],
          ...stage.viewErrors?.map(copy => [copy.id, version({ ...copy, error: kernelErrorData(copy.error) })] as const) ?? [],
        ]));
        const frame: Extract<Frame, { t: 'snap' }> = {
          t: 'snap',
          sub: sub.id,
          gen: stage.gen,
          list: members(stage.state),
          covered: [...stage.state.covered, ...stage.computed?.map(node => node.$id) ?? [], ...stage.viewErrors?.map(copy => copy.id) ?? []],
          copies,
          computed: stage.computed,
          viewErrors: stage.viewErrors,
          rows: stage.rows,
          viewOwner: stage.viewOwner,
          at: stage.at ?? [result.pos],
          next: stage.state.next,
        };
        return { frame, removed };
      } finally {
        for (const release of result.held.values()) release();
      }
    },
    async result(sub: NodeSubscription) {
      const result = await prepare([sub], false);
      if (result === undefined) return undefined;
      try {
        const stage = result.stages[0];
        if (stage === undefined || !registered(sub) || stage.gen !== sub.gen) return undefined;
        const before = new Set(members(sub.state));
        const after = new Set(members(stage.state));
        const prior = versions.get(sub) ?? new Map<NodeId, string>();
        const current = new Map<NodeId, string>();
        const copies: NodeCopy[] = [];
        for (const [id, image] of result.images) {
          const held = coverage.get(id);
          const transfer = extras.get(sub)?.viewErrors?.some(copy => copy.id === id) === true;
          if (transfer && held !== undefined && !currentImage(image, held)) copies.push(held.copy);
          else if (currentImage(image, held) && (held?.ver !== image.copy.ver || transfer)) copies.push(image.copy);
        }
        const computed = stage.computed?.filter(node => {
          const hash = version(node);
          current.set(node.$id, hash);
          return prior.get(node.$id) !== hash;
        });
        const viewErrors = stage.viewErrors?.filter(copy => {
          const hash = version({ ...copy, error: kernelErrorData(copy.error) });
          current.set(copy.id, hash);
          return prior.get(copy.id) !== hash;
        });
        const rows = stage.rows === undefined || version(stage.rows) === version(extras.get(sub)?.rows)
          ? undefined : stage.rows;
        const { removed } = apply(result, false);
        versions.set(sub, current);
        const frame: Extract<Frame, { t: 'result' }> = { t: 'result', sub: sub.id, gen: stage.gen,
          diff: [...[...before].filter(id => !after.has(id)).map(remove => ({ remove })),
            ...[...after].filter(id => !before.has(id)).map(add => ({ add }))],
          covered: [...stage.state.covered, ...stage.computed?.map(node => node.$id) ?? [], ...stage.viewErrors?.map(copy => copy.id) ?? []],
          copies, computed, viewErrors, rows, viewOwner: stage.viewOwner, at: stage.at ?? [result.pos], next: stage.state.next };
        return { frame, removed };
      } finally { for (const release of result.held.values()) release(); }
    },
    /** Publishes prepared differences only when their ordinary position can advance. */
    async flush(subs: readonly NodeSubscription[], after: (pos: Position) => boolean) {
      const result = await prepare(subs, false);
      if (result === undefined) return undefined;
      try {
        if (result.interrupted || !after(result.pos)) return undefined;
        return { pos: result.pos, intake: result.intake, changes: apply(result, false).changes };
      } finally {
        for (const release of result.held.values()) release();
      }
    },
  };
}
