import { readSnapshot, type NativeHydrationState } from '#tree/read-snapshot';
import { createLaneEffects } from '#tree/lane-effects';
import type { PresentationNode } from '#tree/presentation';
import type { TwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import type { ErrorCopy, Node, NodeCopy, SubSelector } from '@treenx/core/kernel/types';
import { createNativeTreeSource, type NativeSnapshot, type NativeMount } from '#tree/native-source';
import {
  EMPTY_CHILDREN_SNAPSHOT, EMPTY_PATH_SNAPSHOT,
  type ChildrenOpts, type ChildrenSnapshot, type PathSnapshot, type TreeSource,
} from '#tree/tree-source';

interface Resource {
  readonly selector: SubSelector;
  owners: number;
  operation?: 'append' | 'refetch';
  observed?: NativeSnapshot;
  presentationVersion?: number;
  children?: ChildrenSnapshot;
  path?: PathSnapshot;
}

/** Present an actual projection failure without treating it as an absent node. */
function node(copy: NodeCopy): Node {
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

/** Adapt canonical lane resources to the public hooks while retaining their actual cache ownership. */
export function createLaneTreeSource(client: TwpClient, initial?: NativeHydrationState): TreeSource & { readonly effects: ReturnType<typeof createLaneEffects>['effects']; getSelectorSnapshot(selector: SubSelector): NativeSnapshot; mountSelector(selector: SubSelector): NativeMount; close(): void } {
  const native = createNativeTreeSource(client);
  const mutations = createLaneEffects(client);
  const presentation = mutations.presentation;
  const resources = new Map<string, Resource>();
  const hydrated = new Map(initial?.reads.map(read => [JSON.stringify(read.selector), readSnapshot(read.result)]));
  for (const read of initial?.reads ?? []) resources.set(JSON.stringify(read.selector), { selector: read.selector, owners: 0 });

  /** Real admission replaces temporary server presentation, including refusal or absence. */
  function visible(selector: SubSelector): NativeSnapshot {
    const snapshot = native.getSnapshot(selector);
    const key = JSON.stringify(selector);
    if (snapshot.phase !== 'loading') hydrated.delete(key);
    return hydrated.get(key) ?? snapshot;
  }
  const pathListeners = new Map<string, Set<() => void>>();
  const childListeners = new Map<string, Set<() => void>>();
  const closedError = new KernelError('CANCELLED', 'Lane source is closed');
  const closedPath: PathSnapshot = { data: undefined, status: 'error', error: closedError };
  const closedChildren: ChildrenSnapshot = { data: [], phase: 'error', nextCursor: null, error: closedError };
  let closed = false;

  /** Keep query and page-size resources separate; watch flags share the same canonical live subscription. */
  function childSelector(path: string, options?: ChildrenOpts): SubSelector {
    return { children: path, window: { limit: options?.limit ?? 100 },
      ...(options?.query === undefined ? {} : { where: options.query }) };
  }

  /** Register a passive listener; mounting owns all subscription side effects. */
  function listen(listeners: Map<string, Set<() => void>>, path: string, callback: () => void): () => void {
    let active = listeners.get(path);
    if (active === undefined) { active = new Set(); listeners.set(path, active); }
    active.add(callback);
    return () => {
      active!.delete(callback);
      if (active!.size === 0) listeners.delete(path);
    };
  }

  /** Notify legacy hook subscriptions after canonical resource snapshots have settled. */
  function notify(resource: Resource): void {
    const callbacks = 'node' in resource.selector
      ? pathListeners.get(resource.selector.node) : childListeners.get(resource.selector.children);
    for (const callback of callbacks ?? []) callback();
  }

  /** Project copied or subscription-owned computed members atomically, preserving failures. */
  function childrenSnapshot(resource: Resource): ChildrenSnapshot {
    if (closed) return closedChildren;
    const snapshot = visible(resource.selector);
    if (resource.observed === snapshot && resource.presentationVersion === presentation.version && resource.children !== undefined) return resource.children;
    resource.observed = snapshot;
    resource.presentationVersion = presentation.version;
    if (snapshot.phase === 'ready') resource.operation = undefined;
    const data: PresentationNode[] = [];
    const errors: ErrorCopy[] = [];
    const error = snapshot.error ?? null;
    function present(copy: NodeCopy): void {
      if ('error' in copy) errors.push(copy);
      else data.push(presentation.project(copy.node));
    }
    if (snapshot.output === undefined) for (const copy of snapshot.members) present(copy);
    else for (const member of snapshot.output)
      if (member.kind === 'computed') data.push(member.node);
      else present(member.copy);
    const phase = error !== null ? 'error' : snapshot.phase === 'ready' ? 'ready'
      : resource.operation ?? 'initial';
    resource.children = { data, errors, phase, error, nextCursor: snapshot.next ?? null };
    return resource.children;
  }

  /** Settle absence from a completed snapshot and expose projection refusals as errors. */
  function pathSnapshot(resource: Resource): PathSnapshot {
    if (closed) return closedPath;
    const snapshot = visible(resource.selector);
    if (resource.observed === snapshot && resource.presentationVersion === presentation.version && resource.path !== undefined) return resource.path;
    resource.observed = snapshot;
    resource.presentationVersion = presentation.version;
    let data: PresentationNode | undefined, error: Error | null = snapshot.error ?? null;
    try {
      const member = snapshot.output?.[0];
      if (member !== undefined) data = member.kind === 'computed' ? member.node : presentation.project(node(member.copy));
      else if (snapshot.members[0] !== undefined) data = presentation.project(node(snapshot.members[0]));
    } catch (received) {
      if (!(received instanceof KernelError)) throw received;
      error = received;
    }
    resource.path = { data, error, status: error !== null ? 'error'
      : snapshot.phase === 'loading' ? 'loading' : data === undefined ? 'not_found' : 'ready' };
    return resource.path;
  }

  /** Acquire one canonical coverage owner and release it exactly once on disposal. */
  function acquire(selector: SubSelector) {
    if (closed) throw closedError;
    const key = JSON.stringify(selector);
    let resource = resources.get(key);
    if (resource === undefined) {
      resource = { selector, owners: 0 };
      resources.set(key, resource);
    }
    const owned = resource;
    owned.owners++;
    const handle = native.mount(selector);
    const unsubscribe = handle.subscribe(() => notify(owned));
    notify(owned);
    let disposed = false;
    return { resource: owned, handle,
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        handle.dispose();
        if (--owned.owners === 0) resources.delete(key);
        notify(owned);
      } };
  }

  const unsubscribePresentation = presentation.subscribe(() => {
    for (const resource of resources.values()) notify(resource);
  });

  return {
    effects: mutations.effects,
    getPathSnapshot(path) {
      if (closed) return closedPath;
      const resource = resources.get(JSON.stringify({ node: path }));
      return resource === undefined ? EMPTY_PATH_SNAPSHOT : pathSnapshot(resource);
    },
    getChildrenSnapshot(path, options) {
      if (closed) return closedChildren;
      const resource = resources.get(JSON.stringify(childSelector(path, options)));
      return resource === undefined ? EMPTY_CHILDREN_SNAPSHOT : childrenSnapshot(resource);
    },
    subscribePath: (path, callback) => listen(pathListeners, path, callback),
    subscribeChildren: (path, callback) => listen(childListeners, path, callback),
    mountPath(path) {
      const owned = acquire({ node: path });
      return { refetch: () => owned.handle.refetch(), dispose: owned.dispose };
    },
    mountChildren(path, options) {
      const owned = acquire(childSelector(path, options));
      return {
        getSnapshot: () => childrenSnapshot(owned.resource),
        subscribe: listener => owned.handle.subscribe(listener),
        refetch() { owned.resource.operation = 'refetch'; owned.handle.refetch(); },
        loadMore() {
          const snapshot = owned.handle.getSnapshot();
          if (snapshot.phase !== 'ready' || snapshot.next === undefined) return;
          owned.resource.operation = 'append';
          owned.handle.loadMore();
        },
        dispose: owned.dispose,
      };
    },
    getSelectorSnapshot: visible,
    mountSelector(selector) {
      const handle = native.mount(selector);
      return { ...handle, getSnapshot: () => visible(selector),
        dispose() { hydrated.delete(JSON.stringify(selector)); handle.dispose(); } };
    },
    /** Notify mounted readers of cancellation before releasing all cached presentation references. */
    close() {
      if (closed) return;
      closed = true;
      unsubscribePresentation();
      mutations.close();
      for (const resource of resources.values()) {
        resource.observed = undefined;
        resource.path = undefined;
        resource.children = undefined;
      }
      native.close();
      resources.clear();
      hydrated.clear();
      pathListeners.clear();
      childListeners.clear();
    },
  };
}
