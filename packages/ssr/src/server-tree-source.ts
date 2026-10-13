import { KernelError } from '@treenx/core/errors';
import type { ErrorCopy, Reader, ReadResult, SubSelector } from '@treenx/core/kernel/types';
import { readSnapshot, type NativeHydrationState } from '@treenx/react/tree/read-snapshot';
import type { NativeMount, NativeSnapshot } from '@treenx/react/tree/native-source';
import type { ChildrenOpts, ChildrenSnapshot, PathSnapshot, TreeSource } from '@treenx/react/tree/tree-source';

interface Resource {
  readonly selector: SubSelector;
  result?: ReadResult;
  snapshot: NativeSnapshot;
  path?: PathSnapshot;
  children?: ChildrenSnapshot;
}
const LOADING: NativeSnapshot = { phase: 'loading', generations: [], members: [], included: [] };
const noop = () => {};

/** Own the request's native reads across bounded server render passes. */
export class ServerTreeSource implements TreeSource {
  readonly schemaMode = 'declared';
  private readonly resources = new Map<string, Resource>();
  private readonly pendingReads = new Set<Resource>();

  constructor(private readonly reader: Reader) {}

  private resource(selector: SubSelector): Resource {
    const key = JSON.stringify(selector);
    let resource = this.resources.get(key);
    if (resource === undefined) {
      resource = { selector: structuredClone(selector), snapshot: LOADING };
      this.resources.set(key, resource);
      this.pendingReads.add(resource);
    }
    return resource;
  }

  private childSelector(path: string, options?: ChildrenOpts): SubSelector {
    return { children: path, window: { limit: options?.limit ?? 100 },
      ...(options?.query === undefined ? {} : { where: options.query }) };
  }

  getPathSnapshot(path: string): PathSnapshot {
    const resource = this.resource({ node: path });
    if (resource.path !== undefined) return resource.path;
    const snapshot = resource.snapshot;
    const member = snapshot.output?.[0];
    if (member?.kind === 'copy' && 'error' in member.copy)
      return resource.path = { data: undefined, status: 'error', error: new KernelError(member.copy.error.code, member.copy.error.message) };
    const data = member?.kind === 'computed' ? member.node
      : member !== undefined && 'node' in member.copy ? member.copy.node : undefined;
    return resource.path = { data, error: snapshot.error ?? null, status: snapshot.phase === 'loading' ? 'loading'
      : snapshot.error !== undefined ? 'error' : data === undefined ? 'not_found' : 'ready' };
  }

  getChildrenSnapshot(path: string, options?: ChildrenOpts): ChildrenSnapshot {
    const resource = this.resource(this.childSelector(path, options));
    if (resource.children !== undefined) return resource.children;
    const snapshot = resource.snapshot;
    const data: ChildrenSnapshot['data'] = [];
    const errors: ErrorCopy[] = [];
    for (const member of snapshot.output ?? []) {
      if (member.kind === 'computed') data.push(member.node);
      else if ('error' in member.copy) errors.push(member.copy);
      else data.push(member.copy.node);
    }
    return resource.children = { data, errors, phase: snapshot.phase === 'loading' ? 'initial' : snapshot.phase,
      error: snapshot.error ?? null, nextCursor: snapshot.next ?? null };
  }

  subscribePath() { return noop; }
  subscribeChildren() { return noop; }
  mountPath(path: string) { this.resource({ node: path }); return { refetch: noop, dispose: noop }; }
  mountChildren(path: string, options?: ChildrenOpts) {
    this.resource(this.childSelector(path, options));
    return { getSnapshot: () => this.getChildrenSnapshot(path, options), subscribe: () => noop,
      loadMore: noop, refetch: noop, dispose: noop };
  }
  getSelectorSnapshot(selector: SubSelector) { return this.resource(selector).snapshot; }
  mountSelector(selector: SubSelector): NativeMount {
    const resource = this.resource(selector);
    return { getSnapshot: () => resource.snapshot, subscribe: () => noop,
      loadMore: noop, refetch: noop, dispose: noop };
  }

  /** Return how many reads still need to be flushed. */
  pendingCount() { return this.pendingReads.size; }

  /** List pending path and child reads for the unresolved-render error. */
  pending() {
    const paths: string[] = [], children: string[] = [];
    for (const resource of this.pendingReads)
      if ('node' in resource.selector) paths.push(resource.selector.node);
      else children.push(resource.selector.children);
    return { paths, children };
  }

  /** Native failures remain visible to the render owner; no partial hydration is published. */
  async flushPending(): Promise<void> {
    const pending = [...this.pendingReads];
    this.pendingReads.clear();
    await Promise.all(pending.map(async resource => {
      const result = await this.reader.read(resource.selector);
      resource.snapshot = readSnapshot(result);
      resource.result = result;
      resource.path = undefined; resource.children = undefined;
    }));
  }

  /** Serialize completed native reads for the client hydration cache. */
  serialize(): NativeHydrationState {
    const reads: NativeHydrationState['reads'][number][] = [];
    for (const resource of this.resources.values()) {
      if (resource.result === undefined) throw new KernelError('INVALID', 'Hydration contains an unresolved read');
      reads.push({ selector: resource.selector, result: resource.result });
    }
    return { reads };
  }
}
