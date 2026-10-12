import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSchemas } from '#schema/extract-schemas-oxc';
import type { TypeSchema } from '#schema/types';

test('generates native action declarations alongside implemented methods and data fields', async () => {
  const temp = fileURLToPath(new URL('../../../temp/', import.meta.url));
  await mkdir(temp, { recursive: true });
  const fixture = await mkdtemp(join(temp, 'interface-schema-'));
  await writeFile(join(fixture, 'types.ts'), `
    import { registerType } from '@treenx/core/comp';
    class Widget {
      count = 0;
      increment() { this.count++; }
    }
    interface Widget {
      /** @read @description Inspect the requested path. */
      inspect(data: { path: string }): Promise<{ found: boolean }>;
    }
    registerType('test.native-widget', Widget);
  `);

  await generateSchemas([fixture]);
  const schema: TypeSchema = JSON.parse(await readFile(join(fixture, 'schemas/test.native-widget.json'), 'utf8'));
  assert.deepEqual(schema.properties.count, { type: 'number', default: 0 });
  assert.deepEqual(schema.methods?.increment.arguments, []);
  assert.equal(schema.methods?.inspect.kind, 'read');
  assert.equal(schema.methods?.inspect.description, 'Inspect the requested path.');
  assert.equal(schema.methods?.inspect.arguments?.[0].properties?.path.type, 'string');
  assert.equal(schema.methods?.inspect.return?.properties?.found.type, 'boolean');
});
