import { readFile } from 'node:fs/promises';
import type { ModuleManifest, Node, NodeInput } from '#kernel/types';
import type { TypeSchema } from '#schema/types';
import { deployPrefabAction } from '#mod/native-prefab-actions';

export type CapturedSeedNode = NodeInput | Node;
export type NativePrefabSource = NodeInput & {
  readonly $type: 't.prefab';
  readonly mod: string;
  readonly name: string;
  readonly nodes: readonly NodeInput[];
};

/** Publish the existing prefab owner's canonical schema without importing its retiring deploy executor. */
export async function nativePrefabManifest(): Promise<ModuleManifest> {
  const schema: TypeSchema = JSON.parse(await readFile(new URL('./schemas/t.prefab.json', import.meta.url), 'utf8'));
  return { id: '@treenx/core/prefab', security: [], open: [], types: [
    { name: 't.prefab', module: '@treenx/core/prefab', security: 'ordinary', version: 0,
      schema: { ...schema, required: ['mod', 'name', 'nodes'] }, actions: { deploy: deployPrefabAction } },
  ] };
}
