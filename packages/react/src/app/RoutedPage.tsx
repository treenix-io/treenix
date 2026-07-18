// RoutedPage — dynamic router via /sys/routes refs
// Fetches route ref + target in one call, then reactively renders target via cache.

import { isRef, type NodeData } from '@treenx/core';
import { Render, RenderContext } from '#context';
import { useEffect, useState } from 'react';
import * as cache from '#tree/cache';
import { ingestNode } from '#tree/rebase';
import { usePath } from '#hooks';
import { tabTokenInput, trpc } from '#tree/trpc';

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
    const release = (paths: string[]) =>
      trpc.unwatch.mutate({ paths, ...tabTokenInput })
        .catch((e: unknown) => console.error('[routed-page] unwatch failed:', paths, e));

    trpc.resolve.query({ path: routePath, watch: true, ...tabTokenInput }).then((nodes: unknown) => {
      const arr = nodes as NodeData[];
      const paths = arr.length ? [routePath, ...(arr[1] ? [arr[1].$path] : [])] : null;
      // Fast navigation: cleanup ran before resolve settled — the server watch
      // was still registered, release it right here (core-m77/C46).
      if (cancelled) { if (paths) release(paths); return; }
      watched = paths;
      if (!arr.length) { setNotFound(true); return; }

      // F2/inv.18: reads never bypass the rebase-aware ingest — a raw put
      // would clobber overlays and regress newer event images.
      for (const n of arr) cache.put(ingestNode(n));

      const route = arr[0];
      setTargetPath(isRef(route) && arr[1] ? arr[1].$path : route.$path);
    }).catch((e: unknown) => {
      if (cancelled) return;
      console.error('[routed-page] resolve failed:', routePath, e);
      setNotFound(true);
    });

    return () => {
      cancelled = true;
      // core-m77/C46: resolve{watch:true} registered server watches — release on unmount/route change.
      if (watched) release(watched);
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
