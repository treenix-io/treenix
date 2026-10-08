import { assertSafePath, dirname } from '#core/path';
import type { LaneBranch, LaneRange, LaneRoot } from '#kernel/lane-selection';
import type { Cursor, DomainId, NodeId, Path, SubSelector } from '#kernel/types';

export interface SubscriptionBranch {
  readonly covered: readonly NodeId[];
  readonly paths: readonly Path[];
  readonly rights: readonly Path[];
}
export interface SubscriptionRoot extends SubscriptionBranch {
  readonly path: Path;
  readonly member?: NodeId;
}
export interface SubscriptionState {
  readonly roots: ReadonlyMap<Path, SubscriptionRoot>;
  readonly fixed: SubscriptionBranch;
  readonly covered: ReadonlySet<NodeId>;
  readonly domains: readonly DomainId[];
  readonly range?: LaneRange;
  readonly next?: Cursor;
}
export interface NodeSubscription {
  readonly id: string;
  readonly path: Path;
  readonly selector: SubSelector;
  readonly controller: AbortController;
  gen: number;
  ready: boolean;
  initial: boolean;
  dirty: number;
  stamp: number;
  forcePut: boolean;
  full: boolean;
  state: SubscriptionState;
  readonly candidates: Set<Path>;
  readonly changes: Map<Path, { count: number; force: boolean }>;
}
type Route = {
  readonly sub: NodeSubscription;
  readonly root?: Path;
  readonly rightsOnly: boolean;
  readonly allRoots: boolean;
};
const emptyBranch: SubscriptionBranch = { covered: [], paths: [], rights: [] };
/** Retains dependency addresses and coverage without read values or node revisions. */
export function subscriptionBranch(branch: LaneBranch): SubscriptionBranch {
  const paths = new Set(branch.reads.nodes?.map((input) => input.path));
  for (const path of branch.reads.absent ?? []) paths.add(path);
  const rights = new Set<Path>();
  for (const input of branch.reads.dependencies ?? []) {
    if (input.kind === 'rights') rights.add(input.key);
    else if (input.kind === 'target') paths.add(input.key);
  }
  return { covered: branch.covered, paths: [...paths], rights: [...rights] };
}
/** Stores direct membership separately from include coverage. */
export function subscriptionRoot(root: LaneRoot): SubscriptionRoot {
  return {
    path: root.path,
    ...subscriptionBranch(root),
    ...(root.member === undefined ? {} : { member: root.member.id }),
  };
}
/** Combines branch coverage and source domains for membership and reset invalidation. */
export function subscriptionState(
  roots: ReadonlyMap<Path, SubscriptionRoot>,
  fixed: SubscriptionBranch,
  range?: LaneRange,
  next?: Cursor,
  domains: readonly DomainId[] = [],
): SubscriptionState {
  const covered = new Set(fixed.covered);
  for (const root of roots.values()) for (const id of root.covered) covered.add(id);
  return { roots, fixed, covered, range, next, domains };
}

/** Routes accepted changes to affected roots using metadata only. */
export function createSubscriptions() {
  const entries = new Map<string, NodeSubscription>();
  const routes = new Map<Path, Set<Route>>();
  const bindings = new Map<NodeSubscription, { path: Path; route: Route }[]>();
  const children = new Map<Path, Set<NodeSubscription>>();
  /** Records one address dependency so it can be removed with its subscription. */
  function bind(
    sub: NodeSubscription,
    path: Path,
    root: Path | undefined,
    rightsOnly: boolean,
    allRoots = false,
  ): void {
    const route = { sub, root, rightsOnly, allRoots };
    let at = routes.get(path);
    if (at === undefined) {
      at = new Set();
      routes.set(path, at);
    }
    at.add(route);
    bindings.get(sub)!.push({ path, route });
  }
  /** Registers replacement dependencies before the Writer read barrier releases. */
  function capture(sub: NodeSubscription, state: SubscriptionState): void {
    for (const root of state.roots.values()) {
      for (const path of root.paths) bind(sub, path, root.path, false);
      for (const path of root.rights) bind(sub, path, root.path, true);
    }
    for (const path of state.fixed.paths) bind(sub, path, undefined, false);
    for (const path of state.fixed.rights) bind(sub, path, undefined, true);
  }
  /** Removes both installed and provisional dependency routes. */
  function unbind(sub: NodeSubscription): void {
    for (const { path, route } of bindings.get(sub)!) {
      const at = routes.get(path)!;
      at.delete(route);
      if (at.size === 0) routes.delete(path);
    }
    bindings.set(sub, []);
  }
  /** Registers the selector range and its ancestor permission inputs before reading. */
  function rootRoutes(sub: NodeSubscription): void {
    let path: Path | null = sub.path;
    while (path !== null) {
      bind(sub, path, undefined, true, true);
      path = dirname(path);
    }
    if ('node' in sub.selector) bind(sub, sub.path, sub.path, false);
  }
  /** Replaces prepared state and removes superseded provisional routes. */
  function install(sub: NodeSubscription, state: SubscriptionState): void {
    sub.state = state;
    unbind(sub);
    rootRoutes(sub);
    capture(sub, state);
  }
  /** Unregisters one subscription from address and child-range routing. */
  function remove(sub: NodeSubscription): void {
    entries.delete(sub.id);
    unbind(sub);
    bindings.delete(sub);
    if ('children' in sub.selector) {
      const at = children.get(sub.path)!;
      at.delete(sub);
      if (at.size === 0) children.delete(sub.path);
    }
  }
  /** Coalesces pending changes while retaining whether projection must be replaced. */
  function dirty(sub: NodeSubscription, force: boolean): void {
    sub.dirty = Math.min(2, sub.dirty + 1);
    sub.stamp++;
    sub.forcePut ||= force;
  }
  return {
    entries,
    remove,
    capture,
    install,
    /** Owns the selector and registers its range before asynchronous admission. */
    add(id: string, input: SubSelector, gen: number): NodeSubscription {
      const selector = structuredClone(input);
      const path = 'node' in selector ? selector.node : selector.children;
      assertSafePath(path);
      const sub: NodeSubscription = {
        id,
        path,
        selector,
        gen,
        controller: new AbortController(),
        ready: false,
        initial: true,
        dirty: 0,
        stamp: 0,
        forcePut: false,
        full: true,
        candidates: new Set(),
        changes: new Map(),
        state: subscriptionState(new Map(), emptyBranch),
      };
      entries.set(id, sub);
      bindings.set(sub, []);
      rootRoutes(sub);
      if ('children' in selector) {
        let at = children.get(path);
        if (at === undefined) {
          at = new Set();
          children.set(path, at);
        }
        at.add(sub);
      }
      return sub;
    },
    current: (sub: NodeSubscription) => entries.get(sub.id) === sub,
    /** Invalidates affected roots and bounds coalesced paths without charging hidden payloads. */
    changed(path: Path, force: boolean, pendingLimit: number): void {
      const affected = new Map<NodeSubscription, Set<Path>>();
      const parent = dirname(path);
      if (parent !== null)
        for (const sub of children.get(parent) ?? []) affected.set(sub, new Set([path]));
      for (const route of routes.get(path) ?? []) {
        if (route.rightsOnly && !force) continue;
        let candidates = affected.get(route.sub);
        if (candidates === undefined) {
          candidates = new Set();
          affected.set(route.sub, candidates);
        }
        if (route.allRoots) route.sub.full = true;
        if (route.root !== undefined) candidates.add(route.root);
      }
      for (const [sub, candidates] of affected) {
        if (sub.full && sub.forcePut) {
          dirty(sub, true);
          continue;
        }
        for (const candidate of candidates) sub.candidates.add(candidate);
        const previous = sub.changes.get(path);
        sub.changes.set(path, {
          count: Math.min(2, (previous?.count ?? 0) + 1),
          force: force || previous?.force === true,
        });
        dirty(sub, force);
        if (sub.changes.size > pendingLimit) {
          sub.full = true;
          sub.forcePut = true;
          sub.candidates.clear();
          sub.changes.clear();
        }
      }
    },
    /** Coalesces pending changes while retaining whether projection must be replaced. */
    dirty(sub: NodeSubscription, force: boolean): void {
      sub.full = true;
      dirty(sub, force);
    },
  };
}
