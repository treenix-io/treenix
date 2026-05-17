import { type Tree } from '#tree';
import { deploySeedPrefabs } from '../prefab';

export async function seed(tree: Tree) {
  await deploySeedPrefabs(tree);
}
