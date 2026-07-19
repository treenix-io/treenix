// RoutedPage — dynamic router via /sys/routes refs
// Fetches route ref + target in one call, then reactively renders target via cache.

import { isRef, type NodeData } from '@treenx/core';
import { Render, RenderContext } from '#context';
import { useEffect, useState } from 'react';
import * as cache from '#tree/cache';
import { acquireHold, acquireHoldForRegistration, releaseHold, releaseHolds } from '#tree/holds';
import { trackedGet } from '#tree/read-track';
import { ingestNode } from '#tree/rebase';
import { usePath } from '#hooks';
import { tabTokenInput, trpc } from '#tree/trpc';

/** Tracked resolve (the F1 door): the route path competes in its generation
 *  lane with full overlap ordering; the ref target rides the same response —
 *  its own mid-flight overlap is unknowable before the response names it, so
 *  it is ingest-routed here and re-read through the door by the target's
 *  usePath mount. Exported for tests. */
export async function resolveRouteTracked(routePath: string): Promise<NodeData[]> {
  let arr: NodeData[] = [];
  const o = await trackedGet(routePath, async () => {
    arr = (await trpc.resolve.query({ path: routePath, watch: true, ...tabTokenInput })) as NodeData[];
    return arr[0] ?? null;
  });
  if (o.error !== undefined) throw o.error;
  if (o.applied && arr[1]) cache.put(ingestNode(arr[1]));
  return arr;
}

export function RoutedPage({ path }: { path: string }) {
  // Strip trailing slash before composing the route path. Server rejects
  // /sys/routes/t/ as "trailing slash"; the URL /t/ would otherwise produce it.
  const cleanPath = path === '/' ? path : path.replace(/\/+$/, '');
  const routePath = cleanPath === '/' ? '/sys/routes/_index' : `/sys/routes${cleanPath}`;
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Fetch route node + resolved target in one call, cache both
  useEffect(() => {
    setTargetPath(null);
    setNotFound(false);
    let cancelled = false;
    let watched: string[] | null = null;

    // r3-F2: count the route hold BEFORE the registering resolve — a
    // co-consumer's release-to-zero mid-flight would strip the registration
    // this resolve creates; the gate serializes it after any in-flight
    // unwatch of the path. The target path is response-derived — counted on
    // arrival. Every non-success branch below releases the eager count.
    const gate = acquireHoldForRegistration(routePath);

    gate.then(() => resolveRouteTracked(routePath)).then((arr) => {
      // F5: the resolve registered server watches — count them tab-wide; the
      // release below fires unwatch only when no co-consumer holds the path.
      const target = arr.length > 1 ? arr[1].$path : null;
      if (target) acquireHold(target);
      // Fast navigation: cleanup ran before resolve settled — the server watch
      // was still registered, release it right here (core-m77/C46). Releasing
      // the eager route count at cleanup instead could fire the unwatch BEFORE
      // the in-flight resolve registers server-side — a leak.
      if (cancelled) {
        releaseHold(routePath);
        if (target) releaseHold(target);
        return;
      }
      if (!arr.length) {
        releaseHold(routePath); // absent route registered no server watch
        setNotFound(true);
        return;
      }
      watched = [routePath, ...(target ? [target] : [])];

      const route = arr[0];
      setTargetPath(isRef(route) && target ? target : route.$path);
    }).catch((e: unknown) => {
      releaseHold(routePath); // request failure → release the eager count (r3-F2)
      if (cancelled) return;
      console.error('[routed-page] resolve failed:', routePath, e);
      setNotFound(true);
    });

    return () => {
      cancelled = true;
      // core-m77/C46: resolve{watch:true} registered server watches — release on unmount/route change.
      if (watched) releaseHolds(watched);
    };
  }, [routePath]);

  // Reactively subscribe to target node via cache
  const { data: targetNode, loading: targetLoading } = usePath(targetPath, { once: true });

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 text-muted-foreground">
        <div className="text-6xl font-light">404</div>
        <p className="text-sm">Page not found: <span className="font-mono">{path}</span></p>
      </div>
    );
  }

  if (targetLoading || !targetNode) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-2 text-muted-foreground">
        <div className="text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-auto has-[.view-full]:overflow-visible has-[.view-full]:p-0">
        <RenderContext name="react">
          <Render value={targetNode} />
        </RenderContext>
      </div>
    </div>
  );
}
