// Lazy loader: registers t3d.scene view but defers three.js import until render

import { register } from '@treenx/core';
import { type View } from '@treenx/react';
import { lazy, Suspense } from 'react';
import { T3dScene } from './types';

const SceneViewLazy = lazy(() =>
  import('./view-impl').then((m) => ({ default: m.SceneView })),
);

const SceneView: View<T3dScene> = (props) => (
  <Suspense fallback={<div className="w-full h-[600px] rounded-lg bg-black/90 animate-pulse" />}>
    <SceneViewLazy {...props} />
  </Suspense>
);

register(T3dScene, 'react', SceneView);
