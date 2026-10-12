import { readFile } from 'node:fs/promises';
import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { TypeSchema } from '@treenx/core/schema/types';
import { deployPrefabAction } from '#prefab/deploy';

/** Publish the existing prefab owner's canonical schema without importing its retiring deploy executor. */
export async function nativePrefabManifest(): Promise<ModuleManifest> {
  const schema: TypeSchema = JSON.parse(
    await readFile(new URL('./schemas/t.prefab.json', import.meta.url), 'utf8'),
  );
  return {
    id: '@treenx/core/prefab',
    security: [],
    open: [],
    types: [
      {
        name: 't.prefab',
        module: '@treenx/core/prefab',
        security: 'ordinary',
        version: 0,
        schema: {
          ...schema,
          required: ['mod', 'name', 'nodes'],
          properties: {
            ...schema.properties,
            grants: {
              type: 'array',
              items: {
                type: 'object',
                required: ['executor', 'target', 'grant'],
                additionalProperties: false,
                properties: {
                  executor: { type: 'string' },
                  target: { type: 'string' },
                  grant: { type: 'integer', minimum: 1, maximum: 7 },
                },
              },
            },
          },
        },
        actions: { deploy: deployPrefabAction },
      },
    ],
  };
}
