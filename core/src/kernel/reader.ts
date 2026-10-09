import { ancestorPaths, assertSafePath, isChildPath } from '#core/path'
import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { CacheRead } from '#kernel/cache'
import type { NodeChange } from '#kernel/changeset'
import { decodeChainNode } from '#kernel/chain-index'
import type { ExprWork } from '#kernel/eval'
import { createSiftTest } from '#kernel/expr'
import { applyFieldDeltas, applyJournalChange } from '#kernel/journal'
import type { LaneBranch, LaneRange, LaneRoot, LaneSelection } from '#kernel/lane-selection'
import { comparePositions, positionToRev } from '#kernel/position'
import { typeReadVersion, type ReadDependency, type ReadSet } from '#kernel/preconditions'
import { createProjector, visibleNode } from '#kernel/projection'
import { computeRights, type ChainNode } from '#kernel/rights'
import type { AuthReadSource } from '#kernel/session'
import { mapNodeForSift } from '#kernel/store/keys'
import { compareScanKeys, parseScanCursor, scanCursor, scanKey, scanPage, type ScanKey } from '#kernel/store/scan'
import { A, DEFAULT_LIMITS, R, W, type Budget, type DomainId, type HistoryEntry, type IncludeSpec, type JournalImageTypes, type JournalVisibility, type Limits, type Node, type NodeCopy,
  type JournalAddress, type JournalCommit, type JournalRange, type Path, type ReadResult, type Registry, type ScanRange,
  type Selector, type Sort, type Store, type StoredNode, type SubSelector } from '#kernel/types'
import { getByPath } from '#kernel/update-ops'
import type { Writer } from '#kernel/writer'
import { stableJson } from '#util/stable-json'

export interface ReaderTarget {
  readonly id: string
  readonly store: Store
  chain(path: Path): readonly ChainNode[]
  children(path: Path): Iterable<ChainNode>
}
export interface ReaderSource {
  readonly domains: readonly DomainId[]
  readonly auth: AuthReadSource
  resolve(path: Path): ReaderTarget
  /** Canonical, unique Store owners intersecting the logical range. */
  targets(range: ScanRange): readonly ReaderTarget[]
  /** Semantic claim/generation stamp, including empty and unavailable intersections. */
  topology(range: ScanRange): string
}
export interface ReaderOptions {
  readonly registry: Registry
  readonly writer: Pick<Writer, 'cache' | 'stream' | 'read'>
  readonly admission: AuthAdmission
  readonly source: ReaderSource
  readonly budget: Budget
  readonly ledger?: ReaderLedger
  readonly limits?: Limits
  readonly alert?: (path: Path, error: unknown) => void
  readonly projector?: ReturnType<typeof createProjector>
  readonly scope?: { check(): void; hold(lease: CacheRead): void }
}

/** Whole-call costs outlive individual stream read sets and cannot be replenished by a new frame. */
export interface ReaderLedger {
  readonly budget: Budget
  readonly work: ExprWork
  readonly requestLimit: number
  scanned: number
  bytes: number
  requestBytes: number
  failure?: KernelError
}

/** Own one cumulative allowance for caller, executor and nested action frames. */
export function createReaderLedger(budget: Budget, limits: Limits): ReaderLedger {
  return { budget: Object.freeze({ ...budget }), work: { used: 0, limit: budget.exprWork },
    requestLimit: limits.requestBytes, scanned: 0, bytes: 0, requestBytes: 0 }
}

/** Charge actual Store probes to the same monotonic action allowance. */
export function readerOperationCost(ledger: ReaderLedger) {
  /** Keep refused Store work terminal even when trusted handlers catch it. */
  function refuse(error: unknown): never {
    if (error instanceof KernelError && error.code === 'BUDGET') ledger.failure = error
    throw error
  }
  /** Supply only the unspent operation allowance before Store work starts. */
  function budget(): Budget {
    if (ledger.failure !== undefined) throw ledger.failure
    if (Date.now() > ledger.budget.deadline || ledger.work.used > ledger.work.limit)
      refuse(new KernelError('BUDGET', 'Store reads exceeded the action budget'))
    return { ...ledger.budget, nodes: ledger.budget.nodes - ledger.scanned,
      bytes: ledger.budget.bytes - ledger.bytes, exprWork: ledger.work.limit - ledger.work.used }
  }
  /** Account actual domain probes and returned journal bytes. */
  function charge(nodes: number, bytes: number, exprWork = 0): void {
    ledger.scanned += nodes
    ledger.bytes += bytes
    ledger.work.used += exprWork
    if (ledger.scanned > ledger.budget.nodes || ledger.bytes > ledger.budget.bytes || ledger.work.used > ledger.work.limit)
      refuse(new KernelError('BUDGET', 'Store reads exceeded the action budget'))
  }
  return { budget, charge, refuse }
}

function ruleTypes(node: ChainNode, registry: Registry): readonly string[] {
  const names = new Set<string>()
  for (const name of node.types) {
    try {
      const type = registry.type(name)
      if (registry.security(name, 'acl') !== undefined) names.add(type.name)
    } catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'UNKNOWN_TYPE') throw error
      names.add(name)
    }
  }
  return [...names].sort()
}

export function readerRightsInput(node: ChainNode | undefined, registry: Registry): unknown {
  if (node === undefined) return null
  const rules = ruleTypes(node, registry)
  if (!node.hasAcl && !node.hasOwner && rules.length === 0 && node.invalid === undefined) return null
  return { acl: node.hasAcl ? node.acl : undefined, owner: node.hasOwner ? node.owner : undefined,
    rules, invalid: node.invalid, ...(rules.length === 0 ? {} : { id: node.id }) }
}

function path(value: Path): void {
  try { assertSafePath(value) } catch (error) {
    console.error(error)
    throw new KernelError('INVALID', 'Invalid selector path')
  }
}

function includeDepth(include: readonly IncludeSpec[] | undefined, limit: number): void {
  const pending = [...include ?? []].map(spec => ({ spec, depth: 1 }))
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.depth > limit) throw new KernelError('BUDGET', 'Include depth exceeded')
    if ('path' in item.spec) path(item.spec.path)
    else {
      if (item.spec.ref.length === 0) throw new KernelError('INVALID', 'Include needs a reference field')
      for (const spec of item.spec.then ?? []) pending.push({ spec, depth: item.depth + 1 })
    }
  }
}

function reference(node: Node, field: string): Path | undefined {
  const value = getByPath(node, field)
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') { path(value); return value }
  if (typeof value === 'object' && '$ref' in value && typeof value.$ref === 'string') { path(value.$ref); return value.$ref }
  throw new KernelError('INVALID', 'Include field does not contain a reference')
}

interface Loaded {
  readonly copy: NodeCopy;
  readonly visible: Node;
  readonly stored: StoredNode;
  readonly store: Store;
  readonly bits: number;
  readonly sort: Sort;
}

/** Reads canonical projections and records the dependencies used by queries, actions and subscriptions. */
export function createReader(options: ReaderOptions) {
  const { registry, writer, admission, source } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const ledger = options.ledger ?? createReaderLedger(options.budget, limits);
  const allowance = { ...ledger.budget, deadline: Math.min(ledger.budget.deadline, options.budget.deadline) };
  const alert = options.alert ?? ((at: Path, error: unknown) => console.error(at, error));
  const projectCopy = options.projector ?? createProjector({ registry, alert });
  const work = ledger.work;
  const nodes = new Map<Path, string>(),
    absent = new Set<Path>();
  const dependencies = new Map<string, ReadDependency>(),
    selectors: NonNullable<ReadSet['selectors']>[number][] = [];
  const scopeLoaded = options.scope === undefined ? undefined : new Map<Path, Loaded | null>();

  function active(): void {
    options.scope?.check();
    admission.assertActive();
    if (ledger.failure !== undefined) throw ledger.failure;
    if (work.used > work.limit || ledger.requestBytes > Math.min(limits.requestBytes, ledger.requestLimit)
      || ledger.scanned > allowance.nodes || ledger.bytes > allowance.bytes)
      throw new KernelError('BUDGET', 'Read operation budget exceeded');
    if (Date.now() > allowance.deadline) throw new KernelError('BUDGET', 'Read deadline exceeded');
  }
  function depend(input: ReadDependency): void {
    const key = `${input.kind}:${input.key}`;
    if (!dependencies.has(key)) dependencies.set(key, input);
  }
  function target(at: Path): ReaderTarget {
    const found = source.resolve(at);
    depend({ kind: 'target', key: at, value: { id: found.id, domain: found.store.domain } });
    return found;
  }
  /** Pins claimed ranges, including empty targets, before any selection reads their data. */
  function topology(range: ScanRange): void {
    depend({ kind: 'topology', key: stableJson(range), range, value: source.topology(range) });
  }
  /** Carries traversal work into the next phase of the same operation. */
  function remainingBudget(): Budget {
    return { ...remaining(), exprWork: work.limit - work.used };
  }
  function rights(at: Path, found: ReaderTarget, image?: StoredNode, capture = true, chain = found.chain(at)) {
    const inputs = new Map(chain.map((node) => [node.path, node]));
    const ancestors = ancestorPaths(at);
    if (image !== undefined) inputs.set(at, decodeChainNode(image));
    if (capture)
      for (const ancestor of ancestors) {
        if (dependencies.has(`rights:${ancestor}`)) continue;
        const node = inputs.get(ancestor);
        depend({ kind: 'rights', key: ancestor, value: readerRightsInput(node, registry) });
        if (node !== undefined)
          for (const name of ruleTypes(node, registry))
            depend({ kind: 'type', key: name, value: typeReadVersion(registry, name) });
      }
    const ordered = ancestors.flatMap((ancestor) => {
      const node = inputs.get(ancestor);
      return node === undefined ? [] : [node];
    });
    if (ordered.at(-1)?.path !== at)
      ordered.push({
        path: at,
        id: '',
        types: [],
        acl: [],
        hasAcl: false,
        hasOwner: false,
        alerts: [],
      });
    const result = computeRights(admission.actor, ordered, registry);
    for (const failure of result.alerts) alert(failure.path, failure.error);
    active();
    return result;
  }
  function project(stored: StoredNode, selector: Selector): Node | null {
    const bits = rights(stored.$path, source.resolve(stored.$path), stored, false).bits;
    const copy = projectCopy(stored, bits, 'children' in selector ? selector.sort : undefined);
    active();
    return copy === null ? null : 'node' in copy ? copy.node : visibleNode(stored, bits);
  }
  /** Match journal visibility across both addresses of one accepted transition. */
  function historyVisible(change: NodeChange, domain: DomainId): boolean {
    active();
    const images = [change.before, change.after];
    const first = change.after ?? change.before;
    if (first === null) throw new KernelError('INVALID', 'An influence transition has no image');
    const store = source.resolve(first.$path).store;
    if (store.domain !== domain) return false;
    for (const image of images) {
      if (
        image !== null &&
        (source.resolve(image.$path).store !== store ||
          !historyAllowed(image.$path, decodeChainNode(image)))
      )
        return false;
    }
    return true;
  }
  function dependency(input: ReadDependency): unknown {
    if (input.kind === 'topology') return source.topology(input.range);
    if (input.kind === 'actor') return admission.dependency();
    if (input.kind === 'type') return typeReadVersion(registry, input.key);
    if (input.kind === 'epoch') return writer.stream.cursor().epochs[input.key];
    const found = source.resolve(input.key);
    if (input.kind === 'target') return { id: found.id, domain: found.store.domain };
    return readerRightsInput(
      found.chain(input.key).find((node) => node.path === input.key),
      registry,
    );
  }
  function checkDependencies(): void {
    for (const input of dependencies.values())
      if (!isDeepStrictEqual(input.value, dependency(input)))
        throw new KernelError('CONFLICT', 'Read dependencies changed while awaiting data');
  }
  function charge(stored: StoredNode): void {
    active();
    ledger.scanned++;
    ledger.bytes += Buffer.byteLength(JSON.stringify(stored));
    if (ledger.scanned > allowance.nodes || ledger.bytes > allowance.bytes)
      throw new KernelError('BUDGET', 'Read budget exceeded');
  }
  function remaining(): Budget {
    active();
    if (ledger.scanned >= allowance.nodes) throw new KernelError('BUDGET', 'Read node budget exceeded');
    return { ...allowance, nodes: allowance.nodes - ledger.scanned, bytes: allowance.bytes - ledger.bytes };
  }
  // The caller holds source.domains in an ordered read or commit span.
  async function projectedNode(at: Path): Promise<Node | null> {
    active();
    path(at);
    const found = source.resolve(at),
      chain = found.chain(at),
      bits = rights(at, found, undefined, false).bits;
    const expected = chain.find((node) => node.path === at);
    if (expected === undefined || (bits & R) === 0) return null;
    const lease = await writer.cache.fill(found.store, { node: at }, remaining());
    try {
      active();
      const stored = lease.nodes[0];
      if (stored === undefined || stored.$id !== expected.id)
        throw new KernelError('INVALID', 'Accepted metadata differs from its Store');
      charge(stored);
      const currentBits = rights(at, found, undefined, false).bits;
      const copy = projectCopy(stored, currentBits);
      active();
      return copy === null ? null : 'node' in copy ? copy.node : visibleNode(stored, currentBits);
    } finally {
      lease.release();
    }
  }

  function selectorSort(selector: SubSelector): Sort {
    return 'children' in selector ? (selector.sort ?? [['$order', 1]]) : [];
  }
  /** Binds pagination to the actor, target and selector while excluding the changing page cursor. */
  function selectorScope(selector: SubSelector): string {
    const root = 'node' in selector ? selector.node : selector.children;
    return createHash('sha256')
      .update(
        stableJson([
          admission.actor,
          source.resolve(root).id,
          'children' in selector ? source.topology({ children: root }) : undefined,
          {
            ...selector,
            ...('children' in selector
              ? {
                  window:
                    selector.window === undefined ? undefined : { limit: selector.window.limit },
                }
              : {}),
          },
        ]),
      )
      .digest('hex');
  }
  /** Encodes a continuation using the same scope as the original selection. */
  function cursor(selector: SubSelector, key: ScanKey): string {
    active();
    return scanCursor(selectorScope(selector), key);
  }
  /** Selects projected members and includes inside an already held Writer read span. */
  async function selectInSpan(
    input: SubSelector,
    candidates?: readonly Path[],
    range?: LaneRange,
    projectionSort?: Sort,
  ): Promise<LaneSelection> {
    active();
    const selector = structuredClone(input);
    ledger.requestBytes += Buffer.byteLength(JSON.stringify(selector));
    if (ledger.requestBytes > limits.requestBytes)
      throw new KernelError('BUDGET', 'Read request budget exceeded');
    const root = 'node' in selector ? selector.node : selector.children;
    path(root);
    topology('node' in selector ? { node: root } : { children: root });
    includeDepth(selector.include, limits.includeDepth);
    const sort = projectionSort ?? selectorSort(selector);
    if (candidates !== undefined)
      for (const candidate of candidates) {
        if ('node' in selector ? candidate !== root : !isChildPath(root, candidate))
          throw new KernelError('INVALID', 'A selection candidate is outside its range');
      }
    const test =
      'children' in selector && selector.where !== undefined
        ? createSiftTest(selector.where, limits)
        : undefined;

    active();
    await admission.validate(source.auth);
    active();
    const cursor = writer.stream.cursor(),
      at = [cursor.pos];
    depend({ kind: 'actor', key: admission.dependencyKey, value: admission.dependency() });
    for (const domain of source.domains)
      depend({ kind: 'epoch', key: domain, value: cursor.epochs[domain] });
    selectors.push({ selector, at });
    const loaded = scopeLoaded ?? new Map<Path, Loaded | null>(),
      byId = new Map<string, Loaded>(),
      copies = new Map<string, NodeCopy>(),
      held: CacheRead[] = [];
    let visited = new Set<Path>();
    /** Captures dependency addresses for one include branch without retaining node bodies. */
    function branch(covered: readonly string[]): LaneBranch {
      const inputs = new Map<string, ReadDependency>();
      for (const at of visited)
        for (const key of [
          `target:${at}`,
          ...ancestorPaths(at).map((ancestor) => `rights:${ancestor}`),
        ]) {
          const input = dependencies.get(key);
          if (input !== undefined) inputs.set(key, input);
        }
      return {
        covered,
        reads: {
          nodes: [...visited].flatMap((path) => {
            const rev = nodes.get(path);
            return rev === undefined ? [] : [{ path, rev }];
          }),
          absent: [...visited].filter((at) => absent.has(at)),
          dependencies: [...inputs.values()],
        },
      };
    }

    /** Loads a visible projection once per span and keeps its lease until delivery preparation ends. */
    async function load(at: Path): Promise<Loaded | null> {
      active();
      visited.add(at);
      if (loaded.has(at)) {
        const previous = loaded.get(at)!;
        if (previous === null) return null;
        if (
          previous.sort.length === sort.length &&
          previous.sort.every(
            ([field, direction], i) => field === sort[i][0] && direction === sort[i][1],
          )
        ) {
          byId.set(previous.visible.$id, previous);
          return previous;
        }
        const copy = projectCopy(previous.stored, previous.bits, sort);
        if (copy === null)
          throw new KernelError('CONFLICT', 'Projection changed within a read span');
        const value = {
          ...previous,
          copy,
          sort,
          visible: 'node' in copy ? copy.node : visibleNode(previous.stored, previous.bits),
        };
        loaded.set(at, value);
        byId.set(value.visible.$id, value);
        return value;
      }
      const found = target(at),
        chain = found.chain(at),
        bits = rights(at, found).bits;
      const expected = chain.find((node) => node.path === at);
      if (expected === undefined || (bits & R) === 0) {
        loaded.set(at, null);
        absent.add(at);
        return null;
      }
      const lease = await writer.cache.fill(found.store, { node: at }, remaining());
      try {
        active();
      } catch (error) {
        lease.release();
        throw error;
      }
      if (options.scope === undefined) held.push(lease);
      else options.scope.hold(lease);
      const stored = lease.nodes[0];
      if (stored === undefined || stored.$id !== expected.id)
        throw new KernelError('INVALID', 'Accepted metadata differs from its Store');
      charge(stored);
      for (const name of decodeChainNode(stored).types)
        depend({ kind: 'type', key: name, value: typeReadVersion(registry, name) });
      if (!nodes.has(at)) nodes.set(at, positionToRev(stored.$pos));
      const copy = projectCopy(stored, bits, sort);
      active();
      if (copy === null) {
        loaded.set(at, null);
        absent.add(at);
        return null;
      }
      const value = {
        copy,
        visible: 'node' in copy ? copy.node : visibleNode(stored, bits),
        stored,
        store: found.store,
        bits,
        sort,
      };
      loaded.set(at, value);
      byId.set(stored.$id, value);
      return value;
    }
    /** Adds reachable include copies and records missing or hidden targets as branch dependencies. */
    async function includes(
      base: Loaded | undefined,
      specs: readonly IncludeSpec[],
      covered: Set<string>,
    ): Promise<void> {
      for (const spec of specs) {
        active();
        const at =
          'path' in spec
            ? spec.path
            : base === undefined
              ? undefined
              : reference(base.visible, spec.ref);
        if (at === undefined) continue;
        const value = await load(at);
        if (value === null) continue;
        copies.set(value.visible.$id, value.copy);
        covered.add(value.visible.$id);
        if ('ref' in spec && spec.then !== undefined) await includes(value, spec.then, covered);
      }
    }
    try {
      const found = target(root);
      let members: Loaded[], next: string | undefined;
      const scope = selectorScope(selector);
      if ('node' in selector) {
        const value = await load(root);
        if (value === null && candidates === undefined)
          throw new KernelError('NOT_FOUND', 'Node is absent');
        members = value === null ? [] : [value];
      } else {
        rights(root, found);
        const matching: Node[] = [];
        const after =
          selector.window?.after === undefined
            ? undefined
            : parseScanCursor(selector.window.after, scope, sort.length);
        const paths =
          candidates ??
          (function* () {
            for (const child of found.children(root)) yield child.path;
          })();
        for (const child of paths) {
          const value = await load(child);
          if (value === null || (test !== undefined && !test(mapNodeForSift(value.visible), work)))
            continue;
          const key = scanKey(value.visible, sort, value.visible.$path);
          if (
            range !== undefined &&
            (range.upper === null ||
              (after !== undefined && compareScanKeys(key, after, sort) <= 0) ||
              (range.upper !== undefined && compareScanKeys(key, range.upper, sort) > 0))
          )
            continue;
          matching.push(value.visible);
        }
        const page = scanPage(
          matching,
          sort,
          (node) => node.$path,
          scope,
          range === undefined ? selector.window?.after : undefined,
          range === undefined ? selector.window?.limit : undefined,
          active,
        );
        next = page.next;
        members = page.items.map((node) => loaded.get(node.$path)!);
      }
      const fixed = new Set<string>(),
        refs: IncludeSpec[] = [];
      visited = new Set();
      for (const spec of selector.include ?? []) {
        if ('path' in spec) await includes(undefined, [spec], fixed);
        else refs.push(spec);
      }
      const fixedIncludes = branch([...fixed]),
        roots: LaneRoot[] = [];
      const selected = new Map(members.map((member) => [member.visible.$path, member]));
      for (const at of candidates ?? members.map((member) => member.visible.$path)) {
        visited = new Set();
        await load(at);
        const member = selected.get(at),
          covered = new Set<string>();
        if (member !== undefined) {
          copies.set(member.visible.$id, member.copy);
          covered.add(member.visible.$id);
          await includes(member, refs, covered);
        }
        roots.push({
          path: at,
          ...branch([...covered]),
          ...(member === undefined
            ? {}
            : {
                member: {
                  id: member.visible.$id,
                  key: scanKey(member.visible, sort, member.visible.$path),
                },
              }),
        });
      }
      active();
      checkDependencies();

      const images = [...copies].map(([id, copy]) => {
        const value = byId.get(id)!;
        const cached = writer.cache.getAt(value.store, value.visible.$path);
        if (cached === undefined)
          throw new KernelError('INVALID', 'Read image left its cache lease');
        const before =
          cached.delta === undefined
            ? undefined
            : projectCopy(applyFieldDeltas(value.stored, cached.delta, 'from'), value.bits, sort);
        return {
          copy,
          before,
          bytes: Math.max(cached.bytes, Buffer.byteLength(JSON.stringify(copy))),
          retain() {
            active();
            return writer.cache.retain(id);
          },
        };
      });
      const result = {
        roots,
        fixedIncludes,
        images,
        reads: expect(),
        ...(next === undefined ? {} : { next }),
      };
      active();
      return result;
    } finally {
      for (const lease of held) lease.release();
    }
  }
  /** Returns the complete read set required to reject stale action or commit preparation. */
  function expect(): ReadSet {
    active();
    return {
      nodes: [...nodes].map(([path, rev]) => ({ path, rev })),
      absent: [...absent],
      selectors: [...selectors],
      dependencies: [...dependencies.values()],
    };
  }
  /** Owns the selector before waiting for the ordered span, then returns its projected snapshot. */
  async function read(selector: Selector): Promise<ReadResult> {
    try {
      const owned = structuredClone(selector);
      return await writer.read(source.domains, async () => {
        if ('history' in owned) return historyInSpan(owned);
        const selection = await selectInSpan(owned);
        return {
          list: selection.roots.flatMap((root) =>
            root.member === undefined ? [] : [root.member.id],
          ),
          copies: selection.images.map((image) => image.copy),
          at: [writer.stream.cursor().pos],
          ...(selection.next === undefined ? {} : { next: selection.next }),
        };
      });
    } catch (error) {
      refuseBudget(error);
    }
  }
  /** Assert destination authorization without revealing data, retaining its inputs for final OCC. */
  async function requireReadWrite(at: Path): Promise<void> {
    try {
      await assertReadWrite(at);
    } catch (error) {
      refuseBudget(error);
    }
  }
  /** Retain actual budget refusals even when a handler catches one whose counter is exactly at its limit. */
  function refuseBudget(error: unknown): never {
    if (error instanceof KernelError && error.code === 'BUDGET') ledger.failure = error;
    throw error;
  }
  /** Capture authorization in the executor's ordered metadata span. */
  async function assertReadWrite(at: Path): Promise<void> {
    active();
    ledger.requestBytes += Buffer.byteLength(JSON.stringify({ requireReadWrite: at }));
    if (ledger.requestBytes > limits.requestBytes)
      throw new KernelError('BUDGET', 'Read request budget exceeded');
    chargeAuthorization(at.length + 1);
    let prefixWork = at.length + 1;
    for (let index = 1; index < at.length; index++) if (at[index] === '/') prefixWork += index;
    // Both the target chain and rights capture build every prefix, including absent ancestors.
    chargeAuthorization(prefixWork * 2);
    path(at);
    return writer.read(source.domains, async () => {
      active();
      await admission.validate(source.auth);
      active();
      const current = writer.stream.cursor();
      depend({ kind: 'actor', key: admission.dependencyKey, value: admission.dependency() });
      for (const domain of source.domains)
        depend({ kind: 'epoch', key: domain, value: current.epochs[domain] });
      topology({ node: at });
      const found = target(at),
        chain = found.chain(at);
      // Charge the complete metadata traversal before allocating or evaluating the rights fold.
      for (const claim of admission.actor.claims) chargeAuthorization(claim.length + 1);
      for (const scope of admission.actor.scope ?? [])
        chargeAuthorization((at.length + scope.length + 1) * (chain.length + 1));
      for (const node of chain) {
        chargeAuthorization(node.path.length + node.alerts.length + 1);
        for (const entry of node.acl)
          chargeAuthorization('group' in entry.subject ? entry.subject.group.length + 1 : 1);
        for (const type of node.types)
          chargeAuthorization((type.length + 1) * (node.types.length + 1));
      }
      const result = rights(at, found, undefined, true, chain);
      if ((result.bits & (R | W)) !== (R | W))
        throw new KernelError('FORBIDDEN', 'Destination requires read and write rights');
      active();
    });
  }
  /** Bound metadata folding, including rule sorting and prefix comparisons, by the shared action work allowance. */
  function chargeAuthorization(units: number): void {
    work.used += units;
    if (work.used > work.limit)
      throw new KernelError('BUDGET', 'Authorization work budget exceeded');
  }
  /** Intersects current logical rights with the historical type rules before loading journal images. */
  function historyAllowed(at: Path, image?: JournalImageTypes): boolean {
    const found = target(at);
    const current = rights(at, found);
    if ((current.bits & A) === 0) return false;
    if (image === undefined) return true;

    for (const name of image.types)
      depend({ kind: 'type', key: name, value: typeReadVersion(registry, name) });
    let owner;
    for (const node of found.chain(at))
      if (node.path !== at && node.owner !== undefined) owner = node.owner;
    const result = computeRights(admission.actor,
      [{ ...image, acl: [], hasAcl: false, alerts: [] }], registry,
      { ...current.prefix, granted: current.bits, denied: 0, owner });
    for (const failure of result.alerts) alert(failure.path, failure.error);
    active();
    return (result.bits & A) !== 0;
  }
  /** Rejects parent shadow records and checks both recorded addresses under the current topology. */
  function visibleJournalEntry(found: ReaderTarget, entry: JournalVisibility): boolean {
    active();
    if (entry.kind === 'transfer' || source.resolve(entry.path).store !== found.store) return false;
    if (!historyAllowed(entry.path)) return false;
    if (entry.from !== undefined &&
      (source.resolve(entry.from).store !== found.store || !historyAllowed(entry.from))) return false;
    if (entry.before !== null && entry.before !== 'unknown' &&
      !historyAllowed(entry.before.path, entry.before)) return false;
    if (entry.after !== null && !historyAllowed(entry.after.path, entry.after)) return false;
    return true;
  }
  /** Charges metadata traversal and image reconstruction to the same operation across all Stores. */
  async function journalRows(found: ReaderTarget, range: JournalRange): Promise<readonly JournalCommit[]> {
    const deadline = Math.min(allowance.deadline, Date.now() + limits.queryMs);
    const records = await found.store.scan({ range,
      budget: { ...remaining(), exprWork: work.limit - work.used, deadline } });
    active();
    if (Date.now() > deadline) throw new KernelError('BUDGET', 'History query deadline exceeded');
    if (records.cost === undefined) throw new KernelError('INVALID', 'History Store omitted reconstruction cost');
    ledger.scanned += records.cost.nodes;
    ledger.bytes += records.cost.bytes;
    work.used += records.cost.exprWork;
    if (ledger.scanned > allowance.nodes || ledger.bytes > allowance.bytes || work.used > work.limit)
      throw new KernelError('BUDGET', 'History scan budget exceeded');
    return records.items;
  }
  /** Keeps a journal address stable across target enumeration and global page selection. */
  function journalKey(address: JournalAddress): string {
    return stableJson([address.pos, address.id]);
  }
  /** Resolves restore ownership from visible journal metadata inside the caller's ordered read span. */
  async function journalTarget(address: JournalAddress): Promise<ReaderTarget> {
    active();
    const range: ScanRange = { subtree: '/' };
    topology(range);
    depend({ kind: 'actor', key: admission.dependencyKey, value: admission.dependency() });
    for (const domain of source.domains)
      depend({ kind: 'epoch', key: domain, value: writer.stream.cursor().epochs[domain] });
    let owner: ReaderTarget | undefined;
    for (const found of source.targets(range)) {
      await journalRows(found, { journal: '/', accept(entry) {
        if (entry.address.id !== address.id || comparePositions(entry.address.pos, address.pos) !== 0)
          return false;
        if (!visibleJournalEntry(found, entry)) return false;
        if (owner !== undefined && owner.store !== found.store)
          throw new KernelError('INVALID', 'Journal address belongs to multiple Stores');
        owner = found;
        return false;
      } });
    }
    active();
    checkDependencies();
    if (owner === undefined) throw new KernelError('NOT_FOUND', 'Journal address is absent');
    return owner;
  }
  /** Reads administrative journal images under present rights and the recorded type restrictions. */
  async function historyInSpan(
    selector: Extract<Selector, { history: Path }>,
  ): Promise<ReadResult> {
    active();
    ledger.requestBytes += Buffer.byteLength(JSON.stringify(selector));
    if (ledger.requestBytes > limits.requestBytes)
      throw new KernelError('BUDGET', 'Read request budget exceeded');
    path(selector.history);
    if (selector.window?.evict !== undefined)
      throw new KernelError('INVALID', 'History is read-only');
    await admission.validate(source.auth);
    active();
    const snapshot = writer.stream.cursor();
    const range: ScanRange = { subtree: selector.history };
    topology(range);
    const targets = source.targets(range);
    depend({ kind: 'actor', key: admission.dependencyKey, value: admission.dependency() });
    for (const domain of source.domains)
      depend({ kind: 'epoch', key: domain, value: snapshot.epochs[domain] });
    const sort: Sort = [
      ['address.pos.epoch', 1],
      ['address.pos.seq', 1],
    ];
    const scope = stableJson([
      admission.actor,
      source.topology(range),
      selector.history,
      selector.after,
      selector.window?.limit,
    ]);
    const after =
      selector.window?.after === undefined
        ? undefined
        : parseScanCursor(selector.window.after, scope, sort.length);
    if (
      selector.window !== undefined &&
      (!Number.isSafeInteger(selector.window.limit) || selector.window.limit < 1)
    )
      throw new KernelError('INVALID', 'History limit must be positive');
    const metadata: JournalVisibility[] = [];
    const owners = new Map<string, ReaderTarget>();
    for (const found of targets)
      await journalRows(found, {
        journal: selector.history,
        after: selector.after,
        accept(entry) {
          if (!visibleJournalEntry(found, entry)) return false;
          if (
            after !== undefined &&
            compareScanKeys(scanKey(entry, sort, entry.address.id), after, sort) <= 0
          )
            return false;
          metadata.push(entry);
          owners.set(journalKey(entry.address), found);
          return false;
        },
      });

    const page = scanPage(
      metadata,
      sort,
      (entry) => entry.address.id,
      scope,
      selector.window?.after,
      selector.window?.limit,
      active,
    );
    const selected = new Map<ReaderTarget, Set<string>>();
    for (const entry of page.items) {
      const key = journalKey(entry.address);
      const found = owners.get(key)!;
      let keys = selected.get(found);
      if (keys === undefined) {
        keys = new Set();
        selected.set(found, keys);
      }
      keys.add(key);
    }
    const entries = new Map<string, HistoryEntry>();
    for (const [found, keys] of selected) {
      const records = await journalRows(found, {
        journal: selector.history,
        accept: (entry) => keys.has(journalKey(entry.address)),
      });
      for (const record of records) {
        active();
        for (const entry of record.entries) {
          active();
          if (++work.used > work.limit)
            throw new KernelError('BUDGET', 'History work budget exceeded');
          const address = { pos: record.pos, id: entry.id };
          const images = applyJournalChange(entry.change, 'unknown');
          if (images.before !== null && images.before !== 'unknown') {
            charge(images.before);
          }
          if (images.after !== null) {
            charge(images.after);
          }
          entries.set(journalKey(address), {
            address,
            path: entry.path,
            executor: record.executor,
            caller: record.caller,
            ...(record.decision === undefined ? {} : { opId: record.decision.opId }),
            before:
              images.before === null || images.before === 'unknown'
                ? images.before
                : visibleNode(images.before, A | R),
            after: images.after === null ? null : visibleNode(images.after, A | R),
          });
        }
      }
    }
    checkDependencies();
    active();
    selectors.push({ selector, at: [snapshot.pos] });
    return {
      list: [],
      copies: [],
      history: page.items.map((entry) => entries.get(journalKey(entry.address))!),
      at: [snapshot.pos],
      ...(page.next === undefined ? {} : { next: page.next }),
    };
  }
  return {
    read,
    check: active,
    requireReadWrite,
    selectInSpan,
    cursor,
    work,
    project,
    historyVisible,
    projectedNode,
    journalTarget,
    pin: topology,
    remainingBudget,
    dependency,
    domains: () => source.domains,
    expect,
  };
}
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
