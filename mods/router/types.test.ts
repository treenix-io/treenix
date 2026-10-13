import { validateComponent } from '@treenx/core/comp/validate';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import type { TypeSchema } from '@treenx/core/schema/types';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import './types';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

const schemas = new Map(readSchemasFromDir(SCHEMAS).map(schema => [schema.$id, schema]));

function getSchema(type: string): TypeSchema {
  const schema = schemas.get(type);
  if (schema === undefined) throw new Error(`schema not loaded: ${type}`);
  return schema;
}

describe('router mod — t.route schema', () => {

  it('accepts wildcard true', () => {
    const errs = validateComponent(
      { $type: 't.route', wildcard: true },
      getSchema('t.route'), 'route',
    );
    assert.deepEqual(errs, []);
  });

  it('accepts empty (no fields required)', () => {
    const errs = validateComponent(
      { $type: 't.route' },
      getSchema('t.route'), 'route',
    );
    assert.deepEqual(errs, []);
  });

  it('accepts prefix and index', () => {
    const errs = validateComponent(
      { $type: 't.route', wildcard: true, prefix: '/docs', index: 'index' },
      getSchema('t.route'), 'route',
    );
    assert.deepEqual(errs, []);
  });

  it('rejects non-boolean wildcard', () => {
    const errs = validateComponent(
      { $type: 't.route', wildcard: 1 as unknown as boolean },
      getSchema('t.route'), 'route',
    );
    assert.ok(errs.some(e => e.path.endsWith('.wildcard')));
  });

  it('rejects non-string prefix', () => {
    const errs = validateComponent(
      { $type: 't.route', prefix: 42 as unknown as string },
      getSchema('t.route'), 'route',
    );
    assert.ok(errs.some(e => e.path.endsWith('.prefix')));
  });
});
