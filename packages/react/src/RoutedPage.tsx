// RoutedPage — dynamic router via /sys/routes refs
// Fetches route ref + target in one call, then reactively renders target via cache.

import { isRef, type NodeData } from '@treenity/core';
import { Render, RenderContext } from '#context';
import { useEffect, useState } from 'react';
import * as cache from './cache';
import { usePath } from './hooks';
import { trpc } from './trpc';

export function RoutedPage({ path }: { path: string }) {
  const routePath = path === '/' ? '/sys/routes/_index' : `/sys/routes${path}`;
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Fetch route node + resolved target in one call, cache both
  useEffect(() => {
    setTargetPath(null);
    setNotFound(false);

    trpc.resolve.query({ path: routePath, watch: true }).then((nodes: unknown) => {
      const arr = nodes as NodeData[];
      if (!arr.length) { setNotFound(true); return; }

      for (const n of arr) cache.put(n);

      const route = arr[0];
      setTargetPath(isRef(route) && arr[1] ? arr[1].$path : route.$path);
    }).catch(() => setNotFound(true));
  }, [routePath]);

  // Reactively subscribe to target node via cache
  const targetNode = usePath(targetPath, { once: true });

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 text-muted-foreground">
        <div className="text-6xl font-light">404</div>
        <p className="text-sm">Page not found: <span className="font-mono">{path}</span></p>
      </div>
    );
  }

  if (!targetNode) {
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
