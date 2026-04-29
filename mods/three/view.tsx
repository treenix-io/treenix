// Lazy loader: registers t3d.scene view but defers three.js import until render

import { register, type NodeData } from '@treenx/core';
import { lazy, Suspense } from 'react';

const SceneViewLazy = lazy(() =>
  import('./view-impl').then((m) => ({ default: m.SceneView })),
);

function SceneView(props: { value: NodeData }) {
  return (
    <Suspense fallback={<div className="w-full h-[600px] rounded-lg bg-black/90 animate-pulse" />}>
      <SceneViewLazy {...props} />
    </Suspense>
  );
}

register('t3d.scene', 'react', SceneView as never);
