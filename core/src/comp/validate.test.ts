import { type ComponentData, type NodeData, register, resolveExact, unregister } from '#core';
import { KernelError } from '#errors';
import type { PropertySchema, TypeSchema } from '#schema/types';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  addTypeValidator, assertSafeSchema, validateComponent, validateNode, validateValue, type ValidationError,
} from './validate';

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

    it('enum', () => {
      assert.equal(check(2, { type: 'number', enum: [1, 2] }).length, 0);
      assert.deepEqual(check(3, { type: 'number', enum: [1, 2] }).map(e => e.path), ['x']);
    });
  });

  it('enum without a type admits exactly its members', () => {
    assert.equal(check(1, { enum: ['a', 1] }).length, 0);
    assert.equal(check('1', { enum: ['a', 1] }).length, 1);
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

  // ── Integer ──

  describe('integer', () => {
    it('accepts a whole number', () => {
      assert.equal(check(5, { type: 'integer' }).length, 0);
      assert.equal(check(-3, { type: 'integer' }).length, 0);
    });

    it('rejects a fraction and a non-number', () => {
      assert.deepEqual(check(1.5, { type: 'integer' }).map(e => e.path), ['x']);
      assert.deepEqual(check('5', { type: 'integer' }).map(e => e.path), ['x']);
    });

    it('keeps the number bounds', () => {
      assert.equal(check(3, { type: 'integer', minimum: 5 }).length, 1);
      assert.equal(check(15, { type: 'integer', maximum: 10 }).length, 1);
    });
  });

  // ── Null ──

  describe('null', () => {
    it('accepts only null', () => {
      assert.equal(check(null, { type: 'null' }).length, 0);
      assert.equal(check(0, { type: 'null' }).length, 1);
      assert.equal(check(undefined, { type: 'null' }).length, 1);
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

    it('rejects null items in array against item type', () => {
      const def = { type: 'array', items: { type: 'number' } };
      const e = check([1, null, 3], def as any);
      assert.equal(e.length, 1);
      assert.equal(e[0].path, 'x[1]');
      assert.match(e[0].message, /null/);
    });

    it('accepts null items when the item schema admits null', () => {
      assert.equal(check([1, null], { type: 'array', items: { anyOf: [{ type: 'number' }, {}] } }).length, 0);

      const numOrNull: PropertySchema = { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'null' }] } };
      assert.equal(check([null, 2], numOrNull).length, 0);
      assert.deepEqual(check([null, 'a'], numOrNull).map(e => e.path), ['x[1]']);
    });

    it('rejects null items against an object item schema', () => {
      const e = check([null], { type: 'array', items: { type: 'object', properties: {} } });
      assert.deepEqual(e.map(x => x.path), ['x[0]']);
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

  // ── Object required ──

  describe('object required', () => {
    it('rejects missing required fields in nested object', () => {
      const def = {
        type: 'object',
        required: ['x'],
        properties: {
          x: { type: 'number', title: 'X' },
        },
      };
      const e = check({}, def as any, 'obj');
      assert.equal(e.length, 1);
      assert.equal(e[0].path, 'obj.x');
    });

    it('passes when nested required fields present', () => {
      const def = {
        type: 'object',
        required: ['x'],
        properties: {
          x: { type: 'number', title: 'X' },
        },
      };
      assert.equal(check({ x: 5 }, def as any, 'obj').length, 0);
    });

    it('rejects null on a nested required field (null = missing)', () => {
      const def = {
        type: 'object',
        required: ['x'],
        properties: {
          x: { type: 'number', title: 'X' },
        },
      };
      const e = check({ x: null }, def as any, 'obj');
      assert.equal(e.length, 1);
      assert.equal(e[0].path, 'obj.x');
    });

    // The extractor's shape for `{ path: string; expectedRev: number | null; actualRev: number | null }[]`.
    const conflicts: PropertySchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          expectedRev: { anyOf: [{ type: 'number' }, {}] },
          actualRev: { anyOf: [{ type: 'number' }, {}] },
        },
        required: ['path', 'expectedRev', 'actualRev'],
      },
    };

    it('a required field whose schema admits null accepts null, in array items too', () => {
      assert.equal(check([{ path: '/a', expectedRev: null, actualRev: 3 }], conflicts).length, 0);
      assert.equal(check([{ path: '/a', expectedRev: 1, actualRev: null }], conflicts).length, 0);
    });

    it('a required field whose schema rejects null still counts null as missing', () => {
      const e = check([{ path: null, expectedRev: null, actualRev: 3 }], conflicts);
      assert.deepEqual(e.map(x => x.path), ['x[0].path']);
    });

    it('a required field absent from properties counts null as missing', () => {
      const e = check({ x: null }, { type: 'object', required: ['x'] }, 'obj');
      assert.deepEqual(e.map(x => x.path), ['obj.x']);
    });

    it('a required nullable field still has to be present', () => {
      const e = check([{ path: '/a', actualRev: 3 }], conflicts);
      assert.deepEqual(e.map(x => x.path), ['x[0].expectedRev']);
    });
  });

  // ── Edge cases ──

  it('no type = no validation', () => {
    assert.equal(check('anything', {}).length, 0);
  });

  it('unknown type = no validation', () => {
    assert.equal(check('anything', { type: 'custom-widget' }).length, 0);
  });

  it('a type named like an Object.prototype member is an unknown type', () => {
    assert.equal(check('anything', { type: '__proto__' }).length, 0);
    assert.equal(check('anything', { type: 'hasOwnProperty' }).length, 0);
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

  it('rejects missing required fields', () => {
    const schema: TypeSchema = {
      title: 'Test',
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
      },
      required: ['name'],
    };
    const comp: ComponentData = { $type: 'test' }; // name missing
    const e = validateComponent(comp, schema, 'test');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'test.name');
  });

  it('passes when required fields are present', () => {
    const schema: TypeSchema = {
      title: 'Test',
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
      },
      required: ['name'],
    };
    const comp: ComponentData = { $type: 'test', name: 'Alice' };
    assert.equal(validateComponent(comp, schema, 'test').length, 0);
  });

  it('skips optional fields when not in required', () => {
    const schema: TypeSchema = {
      title: 'Test',
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
      },
    };
    const comp: ComponentData = { $type: 'test' }; // name missing but not required
    assert.equal(validateComponent(comp, schema, '').length, 0);
  });

  it('rejects null on a required field (null = missing)', () => {
    const schema: TypeSchema = {
      title: 'Test',
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
      },
      required: ['name'],
    };
    const comp: ComponentData = { $type: 'test', name: null };
    const e = validateComponent(comp, schema, 'test');
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'test.name');
  });

  it('accepts null on a required field whose schema admits null', () => {
    const schema: TypeSchema = {
      type: 'object',
      properties: { rev: { anyOf: [{ type: 'number' }, {}] } },
      required: ['rev'],
    };
    assert.equal(validateComponent({ $type: 'test', rev: null }, schema, 'test').length, 0);
  });

  it('a required number-or-null field accepts null and rejects other types', () => {
    const schema: TypeSchema = {
      type: 'object',
      properties: { rev: { anyOf: [{ type: 'number' }, { type: 'null' }] } },
      required: ['rev'],
    };
    assert.equal(validateComponent({ $type: 'test', rev: null }, schema, 'test').length, 0);
    assert.equal(validateComponent({ $type: 'test', rev: 2 }, schema, 'test').length, 0);
    assert.deepEqual(validateComponent({ $type: 'test', rev: 'a' }, schema, 'test').map(e => e.path), ['test.rev']);
  });

  it('allows null on an optional field (null = absent)', () => {
    const schema: TypeSchema = {
      title: 'Test',
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
      },
    };
    const comp: ComponentData = { $type: 'test', name: null };
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

// ── Composition keywords ──

const isCode = (code: string) => (e: unknown) => e instanceof KernelError && e.code === code;

describe('anyOf / oneOf / allOf', () => {
  const numOrStr: PropertySchema = { anyOf: [{ type: 'number' }, { type: 'string' }] };

  it('anyOf passes when any branch matches', () => {
    assert.equal(check(1, numOrStr).length, 0);
    assert.equal(check('a', numOrStr).length, 0);
  });

  it('an anyOf mismatch is one error at the value path', () => {
    const e = check(true, numOrStr);
    assert.equal(e.length, 1);
    assert.equal(e[0].path, 'x');
  });

  it('an empty anyOf branch accepts any value', () => {
    assert.equal(check(true, { anyOf: [{ type: 'number' }, {}] }).length, 0);
  });

  it('an integer branch rejects booleans and fractions', () => {
    const intOrStr: PropertySchema = { anyOf: [{ type: 'integer' }, { type: 'string' }] };
    assert.equal(check(2, intOrStr).length, 0);
    assert.equal(check('a', intOrStr).length, 0);
    assert.deepEqual(check(true, intOrStr).map(e => e.path), ['x']);
    assert.deepEqual(check(1.5, intOrStr).map(e => e.path), ['x']);
  });

  it('a literal union admits only its literals', () => {
    const oneOrA: PropertySchema = { anyOf: [{ type: 'number', enum: [1] }, { type: 'string', enum: ['a'] }] };
    assert.equal(check(1, oneOrA).length, 0);
    assert.equal(check('a', oneOrA).length, 0);
    assert.deepEqual(check(7, oneOrA).map(e => e.path), ['x']);
    assert.deepEqual(check('b', oneOrA).map(e => e.path), ['x']);
  });

  it('oneOf integer-or-null matches exactly one branch for each admitted value', () => {
    const intOrNull: PropertySchema = { oneOf: [{ type: 'integer' }, { type: 'null' }] };
    assert.equal(check(5, intOrNull).length, 0);
    assert.equal(check(null, intOrNull).length, 0);
    assert.deepEqual(check('a', intOrNull).map(e => e.path), ['x']);
  });

  it('anyOf applies to object fields and array items', () => {
    const levels: PropertySchema = {
      type: 'object',
      properties: {
        level: { anyOf: [{ type: 'string', enum: ['info', 'warn'] }, { type: 'array', items: { type: 'string', enum: ['info', 'warn'] } }] },
      },
    };
    assert.equal(check({ level: ['warn'] }, levels).length, 0);
    assert.deepEqual(check({ level: 'debug' }, levels).map(e => e.path), ['x.level']);
    assert.deepEqual(check([1, true, 'a'], { type: 'array', items: numOrStr }).map(e => e.path), ['x[1]']);
  });

  it('type and anyOf both apply', () => {
    const def: PropertySchema = { type: 'string', anyOf: [{ type: 'string', minLength: 3 }, { type: 'string', enum: ['a'] }] };
    assert.equal(check('a', def).length, 0);
    assert.equal(check('ab', def).length, 1);
    assert.equal(check(5, def).length, 2);
  });

  it('oneOf needs exactly one matching branch', () => {
    const def: PropertySchema = { oneOf: [{ type: 'number', minimum: 0 }, { type: 'number', maximum: 10 }] };
    assert.equal(check(-5, def).length, 0);
    assert.equal(check(50, def).length, 0);
    assert.deepEqual(check(5, def).map(e => e.path), ['x']);
    assert.deepEqual(check('a', def).map(e => e.path), ['x']);
  });

  it('allOf reports every failing branch', () => {
    const def: PropertySchema = { allOf: [{ type: 'string', minLength: 5 }, { type: 'string', pattern: '^\\d+$' }] };
    assert.equal(check('12345', def).length, 0);
    assert.equal(check('abc', def).length, 2);
  });
});

// ── additionalProperties ──

describe('additionalProperties', () => {
  const closed: PropertySchema = { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false };

  it('false rejects an undeclared field', () => {
    assert.equal(check({ a: 1 }, closed).length, 0);
    assert.deepEqual(check({ a: 1, b: 2 }, closed).map(e => e.path), ['x.b']);
  });

  it('a schema validates every undeclared field', () => {
    const def: PropertySchema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } };
    assert.deepEqual(check({ a: 's', b: 'no', c: 3 }, def).map(e => e.path), ['x.b']);
  });

  it('true or absent leaves undeclared fields open', () => {
    assert.equal(check({ a: 1, b: 2 }, { ...closed, additionalProperties: true }).length, 0);
    assert.equal(check({ a: 1, b: 2 }, { type: 'object', properties: { a: { type: 'number' } } }).length, 0);
  });

  it('applies to array items', () => {
    const def: PropertySchema = { type: 'array', items: closed };
    assert.deepEqual(check([{ a: 1 }, { a: 2, z: 0 }], def).map(e => e.path), ['x[1].z']);
  });

  it('a component keeps its $ fields and the node\'s # components out of it', () => {
    const schema: TypeSchema = { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false };
    const node: ComponentData = { $type: 'test.closed', $v: 1, $order: 'a0', a: 1, '#named': { $type: 'test.other' } };
    assert.equal(validateComponent(node, schema, '').length, 0);
    assert.deepEqual(validateComponent({ ...node, b: 2 }, schema, '').map(e => e.path), ['test.closed.b']);
  });
});

// ── Pattern cost ──

describe('pattern guard', () => {
  it('a nested-quantifier pattern in a code-registered schema is INVALID', () => {
    assert.throws(() => check('aaaa', { type: 'string', pattern: '(a+)+$' }), isCode('INVALID'));
  });

  it('an oversize pattern in a code-registered schema is INVALID', () => {
    assert.throws(() => check('a', { type: 'string', pattern: 'a'.repeat(300) }), isCode('INVALID'));
  });

  it('a malformed pattern in a code-registered schema is INVALID', () => {
    assert.throws(() => check('a', { type: 'string', pattern: '[' }), isCode('INVALID'));
  });

  it('a safe pattern keeps validating on repeated use', () => {
    const def: PropertySchema = { type: 'string', pattern: '^[a-z]+$' };
    assert.equal(check('abc', def).length, 0);
    assert.equal(check('ABC', def).length, 1);
    assert.equal(check('xyz', def).length, 0);
  });
});

describe('assertSafeSchema', () => {
  it('rejects nested quantifiers anywhere in the schema', () => {
    assert.throws(() => assertSafeSchema({ properties: { x: { anyOf: [{ pattern: '(a*)*' }] } } }, 't'), isCode('INVALID'));
  });

  it('rejects a malformed pattern before anything validates against it', () => {
    assert.throws(() => assertSafeSchema({ properties: { x: { type: 'string', pattern: '[' } } }, 't'), isCode('INVALID'));
  });

  it('rejects a schema deeper than the cap', () => {
    let nested: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 30; i++) nested = { properties: { x: nested } };
    assert.throws(() => assertSafeSchema(nested, 't'), isCode('INVALID'));
  });

  it('accepts an ordinary schema', () => {
    assert.doesNotThrow(() => assertSafeSchema({ properties: { x: { type: 'string', pattern: '^[a-z]+$' } } }, 't'));
  });

  it('rejects a keyword of the wrong shape as INVALID, at any depth and in methods', () => {
    const wrong: Record<string, unknown>[] = [
      { anyOf: 'a' }, { oneOf: {} }, { allOf: ['x'] }, { anyOf: [null] },
      { enum: 'a' }, { required: 'a' }, { required: [1] },
      { additionalProperties: 'no' }, { properties: [] }, { properties: { x: 'string' } }, { items: 'x' },
      { type: 5 }, { pattern: 5 }, { maxLength: '5' },
    ];

    for (const shape of wrong) {
      const label = JSON.stringify(shape);
      assert.throws(() => assertSafeSchema(shape, 't'), isCode('INVALID'), label);
      assert.throws(() => assertSafeSchema({ properties: { x: { items: shape } } }, 't'), isCode('INVALID'), label);
      assert.throws(() => assertSafeSchema({ methods: { go: { arguments: [shape] } } }, 't'), isCode('INVALID'), label);
    }

    for (const methods of ['x', { go: 'x' }, { go: { arguments: {} } }, { go: { arguments: [], return: 'x' } }])
      assert.throws(() => assertSafeSchema({ methods }, 't'), isCode('INVALID'), JSON.stringify(methods));
  });

  it('a pattern inside a method argument schema is checked', () => {
    assert.throws(
      () => assertSafeSchema({ methods: { go: { arguments: [{ properties: { x: { pattern: '(a+)+' } } }] } } }, 't'),
      isCode('INVALID'),
    );
  });

  it('accepts every keyword in its shape, and data under default and enum as data', () => {
    const schema = {
      type: 'object', required: ['a'], additionalProperties: false,
      properties: {
        a: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        b: { type: 'array', items: { oneOf: [{ enum: [1, 'x', null] }] }, maxItems: 3 },
        c: { allOf: [{ type: 'object', additionalProperties: { type: 'number' } }], default: { anyOf: 'data' } },
      },
      methods: { go: { arguments: [{ name: 'data', type: 'object', properties: {} }], return: { type: 'number' } } },
    };
    assert.doesNotThrow(() => assertSafeSchema(schema, 't'));
  });
});

// ── validateNode ──

describe('validateNode', () => {
  const KNOWN = 'test.validate.known';
  const UNKNOWN = 'test.validate.unknown';
  let registeredDefault = false;

  beforeEach(() => {
    register(KNOWN, 'schema', () => ({
      type: 'object',
      properties: { level: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    }));
    // The fallback schema is registered by the server; its presence must not change strict mode.
    if (!resolveExact('default', 'schema')) {
      register('default', 'schema', () => ({ type: 'object', properties: {} }));
      registeredDefault = true;
    }
  });

  afterEach(() => {
    unregister(KNOWN, 'schema');
    if (registeredDefault) unregister('default', 'schema');
    registeredDefault = false;
  });

  const node = (extra: Record<string, unknown> = {}): NodeData => ({ $path: '/n', $type: KNOWN, level: 1, ...extra });

  it('reports an anyOf mismatch on any component', () => {
    assert.equal(validateNode(node()).length, 0);
    assert.deepEqual(validateNode(node({ level: true })).map(e => e.path), [`${KNOWN}.level`]);
    assert.deepEqual(validateNode(node({ '#c': { $type: KNOWN, level: {} } })).map(e => e.path), ['#c.level']);
  });

  it('non-strict skips a component whose type has no schema', () => {
    assert.equal(validateNode({ $path: '/n', $type: UNKNOWN, anything: true }).length, 0);
    assert.equal(validateNode(node({ '#c': { $type: UNKNOWN, anything: true } })).length, 0);
  });

  it('strict rejects an unregistered main type with UNKNOWN_TYPE', () => {
    assert.throws(() => validateNode({ $path: '/n', $type: UNKNOWN }, { strict: true }), isCode('UNKNOWN_TYPE'));
  });

  it('strict rejects an unregistered named component type with UNKNOWN_TYPE', () => {
    assert.throws(() => validateNode(node({ '#c': { $type: UNKNOWN } }), { strict: true }), isCode('UNKNOWN_TYPE'));
  });

  it('strict validates registered types as usual', () => {
    assert.equal(validateNode(node(), { strict: true }).length, 0);
    assert.deepEqual(validateNode(node({ level: true }), { strict: true }).map(e => e.path), [`${KNOWN}.level`]);
  });
});
