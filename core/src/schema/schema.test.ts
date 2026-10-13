import { normalizeType } from '#core/component';
import { declareClientType } from '#comp/client-declaration';
import { readSchemasFromDir, visitSchemaDirectories } from '#schema/load';
import type { TypeSchema } from '#schema/types';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const schemas = new Map<string, TypeSchema>();
function collectSchemas(root: string): void {
  visitSchemaDirectories(root, directory => {
    const entries = readSchemasFromDir(directory);
    for (const schema of entries) schemas.set(schema.$id, schema);
    return entries.length;
  });
}
function getSchema(type: string): TypeSchema {
  const schema = schemas.get(type);
  if (schema === undefined) throw new Error(`schema not loaded: ${type}`);
  return schema;
}

describe('schema loader', () => {
  before(() => {
    // engine/core/src/ — core internal mods, schema fixtures, server actions
    collectSchemas(new URL('..', import.meta.url).pathname);
    // engine/mods/ — board, cafe, agent, etc.
    collectSchemas(new URL('../../../mods', import.meta.url).pathname);
  });

  it('loads owned JSON schemas', () => {
    const types = [...schemas.keys()];
    assert.ok(types.length > 0, 'no schemas loaded');
  });

  it('each schema has $id, type, properties', () => {
    const types = [...schemas.keys()];
    for (const type of types) {
      const schema = getSchema(type);
      assert.equal(schema.$id, type, `$id mismatch for ${type}`);
      assert.equal(schema.type, 'object', `${type} should be type=object`);
      assert.ok(schema.properties !== undefined, `${type} missing properties`);
    }
  });

  it('schemas with properties have titled properties', () => {
    const types = [...schemas.keys()];
    assert.ok(types.length > 0);
    let withTitles = 0;
    for (const type of types) {
      const schema = getSchema(type);
      const props = Object.values(schema.properties);
      if (props.length > 0 && props.every(property => property.title)) withTitles++;
    }
    assert.ok(withTitles > 0, 'no schemas have fully titled properties');
  });

  it('component schemas have methods', () => {
    const schema = getSchema('todo.item');
    assert.ok(schema.methods, 'todo.item missing methods');
    assert.ok(schema.methods.toggle, 'todo.item missing toggle method');
    assert.ok(Array.isArray(schema.methods.toggle.arguments), 'toggle should have arguments array');
  });

  it('emits refType when property type is a registered component class', () => {
    const schema = getSchema('cafe.contact');
    const ms = schema.properties.mailService;
    assert.ok(ms, 'mailService property missing');
    assert.equal(ms.format, 'path', 'format should be path');
    assert.equal(ms.refType, 'cafe.mail', 'refType should reference cafe.mail');
    assert.equal(schema.properties.recipient.refType, undefined, 'recipient should not have refType');
  });

  it('class declarations work independently of schema loading', () => {
    const schema: TypeSchema = {
      $id: 'test.type', type: 'object', title: 'Test',
      properties: { name: { type: 'string', title: 'Name' } },
    };
    class TestType { name = ''; }
    const declaration = declareClientType('test.type', TestType);
    assert.equal(normalizeType(TestType), 'test.type');
    assert.equal(declaration.type, schema.$id);
    assert.equal(schema.title, 'Test');
  });
});
