// Computed bindings retain the selected source's reads, subscriptions and mutation owner.

import { AnyType, getComponents, isRef, type Ref } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { Node } from '@treenx/core/kernel/types';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePath, useTreeEffects } from '#hooks';
import { useTreeSource } from '#tree/tree-source-context';
import type { PresentationNode } from '#tree/presentation';
import type { ChildrenSnapshot, PathSnapshot } from '#tree/tree-source';
import { mergeIntoNode } from '#tree/on-change';
import { evaluateRef, extractArgPaths, isCollectionRef } from './eval';

type Dependency = { readonly kind: 'node' | 'children'; readonly path: string };

/** Find field bindings without modifying their canonical node or component payloads. */
function references(node: PresentationNode | undefined): ReadonlyMap<string, Ref> {
  const result = new Map<string, Ref>();
  if (node === undefined) return result;

  for (const [name, component] of getComponents(node, AnyType)) {
    for (const [field, value] of Object.entries(component)) {
      if (isRef(value) && value.$map !== undefined) result.set(name === '' ? field : `${name}.${field}`, value);
    }
  }
  return result;
}

/** Evaluate refs against owned live coverage; an unfinished dependency keeps its binding unresolved. */
function useReferences(refs: ReadonlyMap<string, Ref>): Readonly<Record<string, unknown>> {
  const source = useTreeSource();
  const dependencies = useMemo(() => {
    const selected = new Map<string, Dependency>();
    function add(kind: Dependency['kind'], path: string): void {
      selected.set(`${kind}:${path}`, { kind, path });
    }
    for (const ref of refs.values()) {
      add(isCollectionRef(ref) ? 'children' : 'node', ref.$ref);
      for (const path of extractArgPaths(ref)) add('node', path);
    }
    return [...selected.values()];
  }, [refs]);

  useEffect(() => {
    const releases = dependencies.map(dependency => {
      if (dependency.kind === 'node') {
        const handle = source.mountPath(dependency.path);
        return () => handle.dispose();
      }

      const handle = source.mountChildren(dependency.path);
      function extend(): void {
        const snapshot = source.getChildrenSnapshot(dependency.path);
        if (snapshot.phase === 'ready' && snapshot.nextCursor !== null) handle.loadMore();
      }
      const unsubscribe = source.subscribeChildren(dependency.path, extend);
      extend();
      return () => { unsubscribe(); handle.dispose(); };
    });
    return () => releases.forEach(release => release());
  }, [source, dependencies]);

  const cached = useRef<{ source: typeof source; refs: typeof refs; snapshots: readonly (PathSnapshot | ChildrenSnapshot)[]; value: Readonly<Record<string, unknown>> }>(undefined);
  const snapshot = useCallback(() => {
    const snapshots = dependencies.map(dependency => dependency.kind === 'node'
      ? source.getPathSnapshot(dependency.path) : source.getChildrenSnapshot(dependency.path));
    const previous = cached.current;
    if (previous?.source === source && previous.refs === refs && snapshots.every((value, index) => value === previous.snapshots[index])) return previous.value;

    let loading = false;
    for (const snapshot of snapshots) {
      if (snapshot.error !== null) throw snapshot.error;
      if ('status' in snapshot) loading ||= snapshot.status === undefined || snapshot.status === 'loading';
      else {
        for (const copy of snapshot.errors ?? []) throw new KernelError(copy.error.code, copy.error.message);
        loading ||= snapshot.phase !== 'ready' || snapshot.nextCursor !== null;
      }
    }
    const value: Record<string, unknown> = {};
    const context = {
      getNode: (path: string) => source.getPathSnapshot(path).data,
      getChildren: (path: string) => source.getChildrenSnapshot(path).data,
    };
    for (const [field, ref] of refs) value[field] = loading ? undefined : evaluateRef(ref, context);
    cached.current = { source, refs, snapshots, value };
    return value;
  }, [source, refs, dependencies]);
  const subscribe = useCallback((changed: () => void) => {
    const releases = dependencies.map(dependency => dependency.kind === 'node'
      ? source.subscribePath(dependency.path, changed) : source.subscribeChildren(dependency.path, changed));
    return () => releases.forEach(release => release());
  }, [source, dependencies]);

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Capture the canonical node and the computed values of its declared field references. */
function useBoundNode(path: string) {
  const { data: node, error } = usePath(path);
  if (error !== null) throw error;
  const refs = useMemo(() => references(node), [node]);
  const computed = useReferences(refs);
  return { node, computed };
}

/** Read computed values from the current source without a global computed store. */
export function useComputed(path: string): Readonly<Record<string, unknown>> {
  return useBoundNode(path).computed;
}

/** Merge resolved fields for rendering and retain a revision-bound canonical editor write. */
export function useResolvedNode(path: string): [PresentationNode | undefined, (next: Node) => Promise<Node>] {
  const { node, computed } = useBoundNode(path);
  const effects = useTreeEffects();
  const save = useCallback(async (next: Node): Promise<Node> => {
    const kernel = effects.kernel;
    if (kernel === undefined) throw new KernelError('UNAVAILABLE', 'Binding edits require a native source');
    const { $id, $rev, ...input } = next;
    await kernel.commit({ changes: [{ op: 'put', node: input }], expect: { nodes: [{ path: next.$path, rev: $rev }] } });
    const copy = (await kernel.read({ node: next.$path })).copies[0];
    if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
    return copy.node;
  }, [effects]);

  if (node === undefined || Object.values(computed).some(value => value === undefined)) return [undefined, save];
  return [mergeIntoNode(node, computed), save];
}

/** Keep a standalone expression and all external argument paths under the selected source. */
export function useEvalRef(path: string, map: string): unknown {
  const refs = useMemo(() => new Map([['value', { $ref: path, $map: map }]]), [path, map]);
  return useReferences(refs).value;
}
