import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refOrComponentValidator } from './validator';
import type { ValidationError } from '@treenx/core/comp/validate';
import type { PropertySchema } from '@treenx/core/schema/types';

const slotDef = { type: 'jsonld.refOrComponent', slotType: 'jsonld.schema-org.PostalAddress' } as unknown as PropertySchema;

function validate(value: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  refOrComponentValidator(value, slotDef as any, 'address', errors);
  return errors;
}

describe('refOrComponentValidator', () => {
  it('accepts a Treenix ref shape', () => {
    assert.equal(validate({ $ref: '/customers/alice' }).length, 0);
  });

  it('accepts a Treenix ref with $type=ref', () => {
    assert.equal(validate({ $type: 'ref', $ref: '/customers/alice' }).length, 0);
  });

  it('accepts a typed component matching the slot type', () => {
    assert.equal(validate({ $type: 'jsonld.schema-org.PostalAddress', streetAddress: '1 Way' }).length, 0);
  });

  it('rejects an object whose $type is not the slot type', () => {
    const errors = validate({ $type: 'jsonld.schema-org.Person', name: 'Bob' });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /expected jsonld\.schema-org\.PostalAddress/);
  });

  it('rejects an object with neither $ref nor matching $type (garbage shape)', () => {
    const errors = validate({ garbage: true });
    assert.equal(errors.length, 1);
  });

  it('rejects a non-object value (string)', () => {
    const errors = validate('a string');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /expected ref or typed component/);
  });

  it('rejects a non-object value (number)', () => {
    assert.equal(validate(42).length, 1);
  });

  it('rejects null', () => {
    assert.equal(validate(null).length, 1);
  });

  it('flags a pack bug if slotType is missing on the schema definition', () => {
    const badDef = { type: 'jsonld.refOrComponent' } as unknown as PropertySchema;
    const errors: ValidationError[] = [];
    refOrComponentValidator({ $type: 'jsonld.schema-org.PostalAddress' }, badDef as any, 'address', errors);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /slotType/);
  });
});
