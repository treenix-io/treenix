import { validateComponent } from '@treenx/core/comp/validate';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import type { TypeSchema } from '@treenx/core/schema/types';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import './index';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

const schemas = new Map(readSchemasFromDir(SCHEMAS).map(schema => [schema.$id, schema]));

function getSchema(type: string): TypeSchema {
  const schema = schemas.get(type);
  if (schema === undefined) throw new Error(`schema not loaded: ${type}`);
  return schema;
}

describe('@treenx/ssr — t.site / t.seo schemas', () => {

  describe('t.site', () => {
    it('accepts a published static site', () => {
      const errs = validateComponent(
        { $type: 't.site', state: 'published', mode: 'static' },
        getSchema('t.site'), 'site',
      );
      assert.deepEqual(errs, []);
    });

    it('rejects unknown mode', () => {
      const errs = validateComponent(
        { $type: 't.site', state: 'draft', mode: 'fast' as 'static' },
        getSchema('t.site'), 'site',
      );
      assert.ok(errs.some(e => e.path.endsWith('.mode')));
    });

    it('rejects unknown state', () => {
      const errs = validateComponent(
        { $type: 't.site', state: 'live' as 'draft', mode: 'static' },
        getSchema('t.site'), 'site',
      );
      assert.ok(errs.some(e => e.path.endsWith('.state')));
    });

    it('flags missing required fields', () => {
      const errs = validateComponent(
        { $type: 't.site' } as { $type: 't.site'; state: 'draft'; mode: 'spa' },
        getSchema('t.site'), 'site',
      );
      const missing = errs.map(e => e.path).sort();
      assert.deepEqual(missing, ['site.mode', 'site.state']);
    });
  });

  describe('t.seo', () => {
    it('accepts minimal seo with title only', () => {
      const errs = validateComponent(
        { $type: 't.seo', title: 'Hello' },
        getSchema('t.seo'), 'seo',
      );
      assert.deepEqual(errs, []);
    });

    it('rejects missing title', () => {
      const errs = validateComponent(
        { $type: 't.seo' } as { $type: 't.seo'; title: string },
        getSchema('t.seo'), 'seo',
      );
      assert.ok(errs.some(e => e.path === 'seo.title'));
    });

    it('rejects unknown robots value', () => {
      const errs = validateComponent(
        { $type: 't.seo', title: 'x', robots: 'allow' as 'index,follow' },
        getSchema('t.seo'), 'seo',
      );
      assert.ok(errs.some(e => e.path.endsWith('.robots')));
    });
  });

});
