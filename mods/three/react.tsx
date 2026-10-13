import { declareClientModule, declareView } from '@treenx/react/context/client-registry';
// Lazy loader: registers t3d.scene view but defers three.js import until render

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

export const clientModules = [
  declareClientModule('@treenx/mods/three/react', [
    declareView(T3dScene, 'react', SceneView)
  ])
];
