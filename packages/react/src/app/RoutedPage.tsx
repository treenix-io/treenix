import type { PresentationNode } from '#tree/presentation';
import { isRef } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { NodeCopy } from '@treenx/core/kernel/types';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { NodeProvider, Render, RenderContext } from '#context';
import type { NativeMount, NativeSnapshot } from '#tree/native-source';
import { useTreeEffects } from '#tree/effects';
import { useTreeSource } from '#tree/tree-source-context';

const LOADING: NativeSnapshot = Object.freeze({ phase: 'loading', generations: [], members: [], included: [] });
const subscribeLoading = () => () => {};
const loadingSnapshot = () => LOADING;

/** Present projection failures with their actual native error code. */
function readable(copy: NodeCopy): PresentationNode {
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

/** Keep the route and its included target under one canonical subscription owner. */
export function RoutedPage({ path }: { path: string }) {
  const source = useTreeSource();
  const effects = useTreeEffects();
  const cleanPath = path === '/' ? path : path.replace(/\/+$/, '');
  const routePath = cleanPath === '/' ? '/sys/routes/_index' : `/sys/routes${cleanPath}`;
  const [owned, setOwned] = useState<{ source: typeof source; path: string; handle: NativeMount }>();
  const handle = owned?.source === source && owned.path === routePath ? owned.handle : undefined;
  const snapshot = useSyncExternalStore(handle?.subscribe ?? subscribeLoading, handle?.getSnapshot ?? loadingSnapshot, () => source.getSelectorSnapshot?.({ node: routePath, include: [{ ref: '$ref' }] }) ?? LOADING);

  useEffect(() => {
    if (source.mountSelector === undefined) throw new KernelError('UNAVAILABLE', 'Routing requires a native selector source');

    const mounted = source.mountSelector({ node: routePath, include: [{ ref: '$ref' }] });
    setOwned({ source, path: routePath, handle: mounted });
    return () => mounted.dispose();
  }, [source, routePath]);

  let target: PresentationNode | undefined;
  let error = snapshot.error;
  try {
    const member = snapshot.output?.[0];
    const route = member === undefined
      ? snapshot.members[0] === undefined ? undefined : readable(snapshot.members[0])
      : member.kind === 'computed' ? member.node : readable(member.copy);

    if (route !== undefined && isRef(route)) {
      const copy = snapshot.included.find(value => ('node' in value ? value.node.$path : value.path) === route.$ref);
      target = copy === undefined ? snapshot.computedIncluded?.find(value => value.$path === route.$ref) : readable(copy);
      const failure = snapshot.viewErrorsIncluded?.find(value => value.path === route.$ref);
      if (failure !== undefined) throw new KernelError(failure.error.code, failure.error.message);
    } else target = route;
  } catch (failure) {
    if (!(failure instanceof KernelError)) throw failure;
    error = failure;
  }

  if (error !== undefined) return <div role="alert" className="p-4 text-destructive">{error.message}</div>;
  if (snapshot.phase === 'loading') return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  if (target === undefined) return <div className="flex h-screen flex-col items-center justify-center gap-4 text-muted-foreground"><div className="text-6xl font-light">404</div><p>Page not found: {path}</p></div>;

  return <div className="flex h-screen flex-col"><div className="flex-1 overflow-auto has-[.view-full]:overflow-visible has-[.view-full]:p-0"><RenderContext name="react"><NodeProvider value={target}><Render value={target} ctx={{ node: target, path: target.$path, execute: (action, data) => effects.execute(target.$path, action, data) }} /></NodeProvider></RenderContext></div></div>;
}
