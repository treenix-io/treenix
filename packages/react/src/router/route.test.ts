import { validateComponent } from '@treenx/core/comp/validate';
import { resolve } from '@treenx/core/core/registry';
import { loadSchemasFromDir } from '@treenx/core/schema/load';
import type { TypeSchema } from '@treenx/core/schema/types';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import './route';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

function getSchema(type: string): TypeSchema {
  const handler = resolve(type, 'schema') as (() => TypeSchema) | null;
  assert.ok(handler, `schema not registered: ${type}`);
  return handler();
}

describe('@treenx/react — t.route schema', () => {
  before(() => { loadSchemasFromDir(SCHEMAS); });

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
