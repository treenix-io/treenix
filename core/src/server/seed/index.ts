import { type NodeData, normalizeType, type TypeId } from '#core';
import { type Tree } from '#tree';
import { deploySeedPrefabs } from '../prefab';

// Ensure is kept for backward compat (used by desktop/seed.ts)
export type Ensure = (
  path: string,
  type: TypeId,
  init?: () => Record<string, unknown>,
  modify?: (node: NodeData) => void,
) => Promise<void>;

export function createEnsure(store: Tree): Ensure {
  return async (path, type, init, modify) => {
    if (await store.get(path)) return;
    const node = { $path: path, $type: normalizeType(type), ...(init ? init() : {}) } as NodeData;
    if (modify) modify(node);
    await store.set(node);
  };
}

export async function seed(store: Tree) {
  await deploySeedPrefabs(store);
}
