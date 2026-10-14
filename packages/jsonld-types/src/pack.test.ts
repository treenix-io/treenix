import { createRegistry } from '../../../core/src/kernel/registry';
import { assertNodeSchema } from '../../../core/src/kernel/schema';
import { KernelError } from '@treenx/core/errors';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientModules, loadSchemaOrgV29Pack, schemaOrgV29NativeManifest } from './pack';

function owningTypes() {
  const types = clientModules[0].types;
  assert.ok(types, 'Schema.org owning module must declare types');
  return types;
}
const declaredTypes = owningTypes();

function personReader() {
  const person = declaredTypes.find((type) => type.type === 'jsonld.schema-org.Person');
  assert.ok(person);
  assert.ok(person.kind === 'schema', 'Person owner must declare a schema');
  return person.createReader();
}

function nativeRegistry() {
  const registry = createRegistry();
  registry.publish(schemaOrgV29NativeManifest());
  return registry;
}

describe('owned Schema.org pack', () => {
  it('declares curated client and native schemas without global publication', () => {
    const manifest = schemaOrgV29NativeManifest();
    assert.ok(manifest.types.some((type) => type.name === 'jsonld.schema-org.Person'));
    assert.ok(manifest.types.some((type) => type.name === 'jsonld.schema-org.Event'));
    const schema = personReader().schema();
    assert.ok(schema);
    assert.equal(schema.$id, 'jsonld.schema-org.Person');
    assert.equal(
      declaredTypes.some((type) => type.type === 'some.other.type'),
      false,
    );
  });

  it('memoizes within the owning schema reader', () => {
    const reader = personReader();
    assert.equal(reader.schema(), reader.schema());
  });

  it('initializes the slot validator idempotently without changing declared schemas', () => {
    const before = clientModules[0].types;
    loadSchemaOrgV29Pack();
    loadSchemaOrgV29Pack();
    assert.equal(clientModules[0].types, before);
  });

  it('accepts a Person through the native owned schema', () => {
    assert.doesNotThrow(() =>
      assertNodeSchema(
        { $type: 'jsonld.schema-org.Person', $v: 0, name: 'Alice' },
        nativeRegistry(),
      ),
    );
  });

  it('rejects scalar type mismatch (AC9)', () => {
    assert.throws(
      () =>
        assertNodeSchema({ $type: 'jsonld.schema-org.Person', $v: 0, name: 42 }, nativeRegistry()),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
  });

  it('rejects missing required (AC12)', () => {
    assert.throws(
      () => assertNodeSchema({ $type: 'jsonld.schema-org.Person', $v: 0 }, nativeRegistry()),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
  });
});
