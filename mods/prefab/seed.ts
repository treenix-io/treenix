import { normalizeType } from '@treenx/core';
import type { NodeInput } from '@treenx/core/kernel/types';
import type { NativeSeedDefinition, NativeSeedGrant } from '@treenx/core/mod/native-prefab';

/** Declare a module's seed source and its catalog parents for administrator installation. */
export function nativeSeed(
  mod: string,
  nodes: readonly NodeInput[],
  parents: readonly NodeInput[] = [],
  grants: readonly NativeSeedGrant[] = [],
): NativeSeedDefinition {
  return {
    sources: [
      { $path: '/sys/mods', $type: 't.dir' },
      { $path: `/sys/mods/${mod}`, $type: 't.dir' },
      { $path: `/sys/mods/${mod}/prefabs`, $type: 't.dir' },
      ...parents,
    ],
    prefabs: [
      {
        target: '/',
        allowAbsolute: true,
        source: {
          $path: `/sys/mods/${mod}/prefabs/seed`,
          $type: 't.prefab',
          mod,
          name: 'seed',
          nodes: nodes.map((node) => ({ ...node, $type: normalizeType(node.$type) })),
          grants,
        },
      },
    ],
  };
}
