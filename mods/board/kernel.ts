import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '#prefab/seed';
import { boardSeed } from './seed-data';

const manifest: ModuleManifest = { id: '@treenx/mods/board', types: [], security: [], open: [] };

/** Install the Board prefab; Plan owns the combined Board and Plan native actions. */
export default function createNativeBoardSeeds(): NativeModuleDeployment {
  const nodes = boardSeed.map(node => node['#mount'] === undefined ? node : {
    ...node, '#mount': { ...node['#mount'], pattern: '' },
  });
  return { manifest, seeds: nativeSeed('board', nodes) };
}
