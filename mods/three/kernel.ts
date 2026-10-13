import { T3dScene, T3dObject, T3dMesh, T3dMaterial, T3dLight, T3dCamera, T3dRigidbody, T3dCollider, T3dAudio, T3dParticles, T3dText, T3dAnimator, T3dLod, T3dTrail, T3dLine, T3dScript } from '#three/types';
import { fileURLToPath } from 'node:url';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import { nativeClassModule } from '#native-module';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '#prefab/seed';
import { threeSeed } from '#three/seed-data';

export default function createNativeThree(): NativeModuleDeployment {
  return {
    manifest: nativeClassModule('@treenx/mods/three', {
      't3d.scene': T3dScene,
      't3d.object': T3dObject,
      't3d.mesh': T3dMesh,
      't3d.material': T3dMaterial,
      't3d.light': T3dLight,
      't3d.camera': T3dCamera,
      't3d.rigidbody': T3dRigidbody,
      't3d.collider': T3dCollider,
      't3d.audio': T3dAudio,
      't3d.particles': T3dParticles,
      't3d.text': T3dText,
      't3d.animator': T3dAnimator,
      't3d.lod': T3dLod,
      't3d.trail': T3dTrail,
      't3d.line': T3dLine,
      't3d.script': T3dScript,
    }, readSchemasFromDir(fileURLToPath(new URL('./schemas', import.meta.url)))),
    seeds: nativeSeed(
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
  };
}
