import { normalizeType } from '#core/component';
import type { Node, NodeInput, OpId } from '#kernel/types';

export interface NativeSeedPrefab {
  readonly source: NodeInput & {
    readonly $type: 't.prefab';
    readonly mod: string;
    readonly name: string;
    readonly nodes: readonly CapturedSeedNode[];
    readonly grants?: readonly NativeSeedGrant[];
  };
  readonly target: string;
  readonly allowAbsolute?: boolean;
  /** Legacy setup belongs to its old runtime and cannot receive a native Tree substitute. */
  readonly setup?: unknown;
}

export interface NativeSeedPlan {
  /** Explicit native module/catalog parents; no ambient discovery or manufactured defaults. */
  readonly sources: readonly NodeInput[];
  readonly prefabs: readonly NativeSeedPrefab[];
  /** Owned by the caller from the actual current intake; retain it unchanged when retrying. */
  readonly opId: OpId;
}

export type NativeSeedDefinition = Omit<NativeSeedPlan, 'opId'>;

export type CapturedSeedNode = NodeInput | Node;
export interface NativeSeedGrant {
  readonly executor: string;
  readonly target: string;
  readonly grant: number;
}
export type NativePrefabSource = NodeInput & {
  readonly $type: 't.prefab';
  readonly mod: string;
  readonly name: string;
  readonly nodes: readonly NodeInput[];
  readonly grants?: readonly NativeSeedGrant[];
};

/** Declare a module's seed source and its catalog parents for administrator installation. */
export function nativeSeed(
  mod: string, nodes: readonly NodeInput[], parents: readonly NodeInput[] = [], grants: readonly NativeSeedGrant[] = [],
): NativeSeedDefinition {
  return {
    sources: [
      { $path: '/sys/mods', $type: 't.dir' },
      { $path: `/sys/mods/${mod}`, $type: 't.dir' },
      { $path: `/sys/mods/${mod}/prefabs`, $type: 't.dir' },
      ...parents,
    ],
    prefabs: [{ target: '/', allowAbsolute: true, source: {
      $path: `/sys/mods/${mod}/prefabs/seed`, $type: 't.prefab', mod, name: 'seed',
      nodes: nodes.map(node => ({ ...node, $type: normalizeType(node.$type) })), grants,
    } }],
  };
}
