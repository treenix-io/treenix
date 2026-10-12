import { T3dObject, T3dMesh, T3dLight, T3dScript } from '#three/types';
import { registerKernelSeeds } from '@treenx/core/kernel';
import { nativeSeed } from '@treenx/core/mod/native-prefab';
import { threeSeed } from '#three/seed-data';

registerKernelSeeds(
  nativeSeed(
    'three',
    threeSeed.map((node) => ({
      ...(node.$type === 't3d.object' ? { ...new T3dObject() } : {}),
      ...node,
      ...(node['#mesh'] === undefined ? {} : { '#mesh': { ...new T3dMesh(), ...node['#mesh'] } }),
      ...(node['#light'] === undefined
        ? {}
        : { '#light': { ...new T3dLight(), ...node['#light'] } }),
      ...(node['#script'] === undefined
        ? {}
        : { '#script': { ...new T3dScript(), ...node['#script'] } }),
    })),
  ),
);
