import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateValue, validateComponent, addTypeValidator, type ValidationError } from './validate';
import type { PropertySchema, TypeSchema } from '#schema/types';
import type { ComponentData } from '#core';

// Helper: collect errors from validateValue
function check(value: unknown, def: Partial<PropertySchema>, path = 'x'): ValidationError[] {
  const errors: ValidationError[] = [];
  validateValue(value, def as PropertySchema, path, errors);
  return errors;
}

describe('validateValue', () => {

  // ── String ──

  describe('string', () => {
    it('passes valid string', () => {
      assert.equal(check('hello', { type: 'string' }).length, 0);
    });

    it('rejects non-string', () => {
      const e = check(42, { type: 'string' });
      assert.equal(e.length, 1);
      assert.match(e[0].message, /expected string/);
    });

    it('minLength', () => {
      assert.equal(check('ab', { type: 'string', minLength: 2 } as any).length, 0);
      const e = check('a', { type: 'string', minLength: 2 } as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /min length 2/);
    });

    it('maxLength', () => {
      assert.equal(check('ab', { type: 'string', maxLength: 5 } as any).length, 0);
      const e = check('toolong', { type: 'string', maxLength: 3 } as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /max length 3/);
    });

    it('pattern', () => {
      assert.equal(check('abc123', { type: 'string', pattern: '^[a-z]+\\d+$' } as any).length, 0);
      const e = check('ABC', { type: 'string', pattern: '^[a-z]+$' } as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /must match/);
    });

    it('enum', () => {
      assert.equal(check('a', { type: 'string', enum: ['a', 'b'] }).length, 0);
      const e = check('c', { type: 'string', enum: ['a', 'b'] });
      assert.equal(e.length, 1);
      assert.match(e[0].message, /must be one of/);
    });
  });

  // ── Number ──

  describe('number', () => {
    it('passes valid number', () => {
      assert.equal(check(42, { type: 'number' }).length, 0);
    });

    it('rejects non-number', () => {
      const e = check('nope', { type: 'number' });
      assert.equal(e.length, 1);
      assert.match(e[0].message, /expected number/);
    });

    it('minimum', () => {
      assert.equal(check(10, { type: 'number', minimum: 5 } as any).length, 0);
      const e = check(3, { type: 'number', minimum: 5 } as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /minimum 5/);
    });

    it('maximum', () => {
      assert.equal(check(5, { type: 'number', maximum: 10 } as any).length, 0);
      const e = check(15, { type: 'number', maximum: 10 } as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /maximum 10/);
    });
  });

  // ── Boolean ──

  describe('boolean', () => {
    it('passes valid boolean', () => {
      assert.equal(check(true, { type: 'boolean' }).length, 0);
    });

    it('rejects non-boolean', () => {
      const e = check(1, { type: 'boolean' });
      assert.equal(e.length, 1);
      assert.match(e[0].message, /expected boolean/);
    });
  });

  // ── Array ──

  describe('array', () => {
    it('passes valid array', () => {
      assert.equal(check([1, 2], { type: 'array' }).length, 0);
    });

    it('rejects non-array', () => {
      const e = check('not array', { type: 'array' });
      assert.equal(e.length, 1);
      assert.match(e[0].message, /expected array/);
    });

    it('minItems', () => {
      assert.equal(check([1, 2], { type: 'array', minItems: 2 } as any).length, 0);
      const e = check([1], { type: 'array', minItems: 2 } as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /min items 2/);
    });

    it('maxItems', () => {
      assert.equal(check([1], { type: 'array', maxItems: 3 } as any).length, 0);
      const e = check([1, 2, 3, 4], { type: 'array', maxItems: 3 } as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /max items 3/);
    });

    it('validates primitive items', () => {
      const def = { type: 'array', items: { type: 'number' } };
      assert.equal(check([1, 2, 3], def as any).length, 0);
      const e = check([1, 'bad', 3], def as any);
      assert.equal(e.length, 1);
      assert.equal(e[0].path, 'x[1]');
      assert.match(e[0].message, /expected number/);
    });

    it('validates object items with properties', () => {
      const def = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            age: { type: 'number', title: 'Age' },
          },
        },
      };
      assert.equal(check([{ name: 'Alice', age: 30 }], def as any).length, 0);

      const e = check([{ name: 'Alice', age: 'thirty' }], def as any);
      assert.equal(e.length, 1);
      assert.equal(e[0].path, 'x[0].age');
      assert.match(e[0].message, /expected number/);
    });

    it('validates nested arrays', () => {
      const def = {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
      };
      assert.equal(check([[1, 2], [3]], def as any).length, 0);

      const e = check([[1, 'x']], def as any);
      assert.equal(e.length, 1);
      assert.equal(e[0].path, 'x[0][1]');
    });

    it('skips null items in array', () => {
      const def = { type: 'array', items: { type: 'number' } };
      assert.equal(check([1, null, 3], def as any).length, 0);
    });

    it('rejects non-object when properties expected', () => {
      const def = {
        type: 'array',
        items: { properties: { name: { type: 'string', title: 'N' } } },
      };
      const e = check(['not-object'], def as any);
      assert.equal(e.length, 1);
      assert.match(e[0].message, /expected object/);
    });
  });

  // ── Object ──

  describe('object', () => {
    it('passes valid object', () => {
      assert.equal(check({}, { type: 'object' }).length, 0);
    });

    it('rejects non-object', () => {
      const e = check('nope', { type: 'object' });
      assert.equal(e.length, 1);
      assert.match(e[0].message, /expected object/);
    });

    it('rejects array as object', () => {
      const e = check([], { type: 'object' });
      assert.equal(e.length, 1);
      assert.match(e[0].message, /expected object, got array/);
    });

    it('validates nested properties', () => {
      const def = {
        type: 'object',
        properties: {
          x: { type: 'number', title: 'X' },
        },
      };
      assert.equal(check({ x: 5 }, def as any).length, 0);
      const e = check({ x: 'bad' }, def as any);
      assert.equal(e.length, 1);
      assert.equal(e[0].path, 'x.x');
    });
  });

  // ── Edge cases ──

  it('no type = no validation', () => {
    assert.equal(check('anything', {}).length, 0);
  });

  it('unknown type = no validation', () => {
    assert.equal(check('anything', { type: 'custom-widget' }).length, 0);
  });

  it('preserves path through nesting', () => {
    const def = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          title: 'Items',
          items: {
            properties: {
              price: { type: 'number', title: 'Price' },
            },
          },
        },
      },
    };
    const e = check({ items: [{ price: 'free' }] }, def as any, 'order');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'order.items[0].price');
  });
});

// ── validateComponent ──

describe('validateComponent', () => {
  it('validates component against schema', () => {
    const schema: TypeSchema = {
      title: 'Money',
      type: 'object',
      properties: {
        amount: { type: 'number', title: 'Amount' },
        currency: { type: 'string', title: 'Currency' },
      },
    };
    const comp: ComponentData = { $type: 'money', amount: 100, currency: 'USD' };
    assert.equal(validateComponent(comp, schema, 'budget').length, 0);
  });

  it('reports errors with component field path', () => {
    const schema: TypeSchema = {
      title: 'Money',
      type: 'object',
      properties: {
        amount: { type: 'number', title: 'Amount' },
      },
    };
    const comp: ComponentData = { $type: 'money', amount: 'bad' };
    const e = validateComponent(comp, schema, 'budget');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'budget.amount');
  });

  it('skips null/undefined values', () => {
    const schema: TypeSchema = {
      title: 'Test',
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
      },
    };
    const comp: ComponentData = { $type: 'test' }; // name missing
    assert.equal(validateComponent(comp, schema, '').length, 0);
  });
});

// ── addTypeValidator ──

describe('addTypeValidator', () => {
  it('extends validation with custom type', () => {
    addTypeValidator('email', (value, _def, path, errors) => {
      if (typeof value !== 'string' || !value.includes('@'))
        errors.push({ path, message: 'invalid email' });
    });

    assert.equal(check('user@test.com', { type: 'email' }).length, 0);
    const e = check('not-email', { type: 'email' });
    assert.equal(e.length, 1);
    assert.match(e[0].message, /invalid email/);
  });
});
