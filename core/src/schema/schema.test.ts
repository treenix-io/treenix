import { registerType } from '#comp';
import { getRegisteredTypes, register, resolve } from '#core';
import { clearRegistry } from '#core/index.test';
import { loadSchemas } from '#schema/load';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import './load';

describe('schema loader', () => {
  before(() => {
    loadSchemas();
  })

  it('loads JSON schemas from dist/schema/ into registry', () => {
    const types = getRegisteredTypes('schema');
    assert.ok(types.length > 0, 'no schemas loaded');
  });

  it('each schema has $id, type, properties', () => {
    const types = getRegisteredTypes('schema');
    for (const type of types) {
      const handler = resolve(type, 'schema') as (() => any) | null;
      assert.ok(handler, `no schema handler for ${type}`);
      const schema = handler();
      assert.equal(schema.$id, type, `$id mismatch for ${type}`);
      assert.equal(schema.type, 'object', `${type} should be type=object`);
      assert.ok(schema.properties !== undefined, `${type} missing properties`);
    }
  });

  it('schemas with properties have titled properties', () => {
    const types = getRegisteredTypes('schema');
    assert.ok(types.length > 0);
    // At least some schemas should have property titles (quality check)
    let withTitles = 0;
    for (const type of types) {
      const schema = (resolve(type, 'schema') as () => any)();
      const props = Object.values(schema.properties ?? {}) as any[];
      if (props.length > 0 && props.every((p: any) => p.title)) withTitles++;
    }
    assert.ok(withTitles > 0, 'no schemas have fully titled properties');
  });

  it('component schemas have methods', () => {
    const handler = resolve('test.fixture', 'schema') as (() => any) | null;
    assert.ok(handler, 'test.fixture schema not loaded');
    const schema = handler();
    assert.ok(schema.methods, 'test.fixture missing methods');
    assert.ok(schema.methods.rename, 'test.fixture missing rename method');
    assert.ok(schema.methods.clear, 'test.fixture missing clear method');
    assert.deepEqual(schema.methods.clear.arguments, []);
    assert.equal(schema.methods.rename.arguments[0].type, 'object');
  });

  it('emits refType when property type is a registered component class', () => {
    const handler = resolve('cafe.contact', 'schema') as (() => any) | null;
    assert.ok(handler, 'cafe.contact schema not loaded');
    const schema = handler();
    const ms = schema.properties.mailService;
    assert.ok(ms, 'mailService property missing');
    assert.equal(ms.format, 'path', 'format should be path');
    assert.equal(ms.refType, 'cafe.mail', 'refType should reference cafe.mail');
    // Non-component fields should NOT have refType
    assert.equal(schema.properties.recipient.refType, undefined, 'recipient should not have refType');
  });

  it('defineComponent works independently of schema loader', () => {
    clearRegistry();

    register('test.type', 'schema', () => ({
      $id: 'test.type',
      type: 'object',
      title: 'Test',
      properties: { name: { type: 'string', title: 'Name' } },
    }));

    class TestType {
      name = '';
    }
    registerType('test.type', TestType);

    const schema = resolve('test.type', 'schema');
    assert.ok(schema, 'schema not in registry');
    assert.equal((schema as () => { title: string })().title, 'Test');
  });
});
