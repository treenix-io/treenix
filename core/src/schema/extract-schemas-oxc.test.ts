import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { generateSchemas } from '#schema/extract-schemas-oxc';

const SCHEMAS_DIR = path.resolve(import.meta.dirname, 'schemas');
const SCHEMA_FILE = path.join(SCHEMAS_DIR, 'test.schema-widget.json');
const EXPORTED_SCHEMA_FILE = path.join(SCHEMAS_DIR, 'test.exported-schema-widget.json');
const IMPORT_FIXTURES_DIR = path.resolve(import.meta.dirname, '_import-fixtures');
const IMPORT_SCHEMAS_DIR = path.join(IMPORT_FIXTURES_DIR, 'schemas');

describe('extract-schemas-oxc', () => {
  let schema: any;
  let exportedSchema: any;
  let alphaSchema: any;
  let betaSchema: any;
  let refSourceSchema: any;
  let warnings: string[];

  before(async () => {
    // Clean previous test artifacts
    await fs.rm(SCHEMA_FILE, { force: true });
    await fs.rm(EXPORTED_SCHEMA_FILE, { force: true });
    await fs.rm(IMPORT_SCHEMAS_DIR, { recursive: true, force: true });

    // Generate from fixture
    warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      await generateSchemas([import.meta.dirname]);
    } finally {
      console.warn = originalWarn;
    }

    schema = JSON.parse(await fs.readFile(SCHEMA_FILE, 'utf-8'));
    exportedSchema = JSON.parse(await fs.readFile(EXPORTED_SCHEMA_FILE, 'utf-8'));
    alphaSchema = JSON.parse(
      await fs.readFile(path.join(IMPORT_SCHEMAS_DIR, 'test.import-collision-alpha.json'), 'utf-8'),
    );
    betaSchema = JSON.parse(
      await fs.readFile(path.join(IMPORT_SCHEMAS_DIR, 'test.import-collision-beta.json'), 'utf-8'),
    );
    refSourceSchema = JSON.parse(
      await fs.readFile(path.join(IMPORT_SCHEMAS_DIR, 'test.ref-source.json'), 'utf-8'),
    );
  });

  after(async () => {
    await fs.rm(SCHEMA_FILE, { force: true });
    await fs.rm(EXPORTED_SCHEMA_FILE, { force: true });
    await fs.rm(IMPORT_SCHEMAS_DIR, { recursive: true, force: true });
  });

  it('sets $id and $schema', () => {
    assert.equal(schema.$id, 'test.schema-widget');
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  });

  it('extracts class-level JSDoc as title', () => {
    assert.equal(schema.title, 'A complex widget for testing schema extraction.');
  });

  it('extracts class-level JSDoc continuation as description', () => {
    assert.equal(
      schema.description,
      'Covers class, property, and method metadata used by the catalog.',
    );
  });

  it('extracts JSDoc from exported classes', () => {
    assert.equal(exportedSchema.title, 'Exported class fixture for JSDoc extraction.');
    assert.equal(exportedSchema.description, undefined);
  });

  // ── Primitives (inferred from initializer) ──

  it('infers string from initializer', () => {
    assert.deepEqual(schema.properties.title, { type: 'string', default: '' });
  });

  it('infers number from initializer', () => {
    assert.deepEqual(schema.properties.count, { type: 'number', default: 0 });
  });

  it('infers boolean from initializer', () => {
    assert.deepEqual(schema.properties.enabled, { type: 'boolean', default: true });
  });

  // ── Primitives (explicit annotation) ──

  it('explicit string annotation', () => {
    assert.deepEqual(schema.properties.label, { type: 'string', default: 'default' });
  });

  it('explicit number annotation', () => {
    assert.deepEqual(schema.properties.size, { type: 'number', default: 42 });
  });

  it('explicit boolean annotation', () => {
    assert.deepEqual(schema.properties.visible, { type: 'boolean', default: false });
  });

  // ── Union enums ──

  it('string union → enum', () => {
    assert.deepEqual(schema.properties.status, {
      type: 'string',
      enum: ['draft', 'active', 'archived'],
      default: 'draft',
    });
  });

  it('string union with 3 values', () => {
    assert.deepEqual(schema.properties.priority, {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    });
  });

  it('numeric literal union → number enum (not anyOf)', () => {
    assert.deepEqual(schema.properties.trustLevel, {
      type: 'number',
      enum: [0, 1, 2, 3, 4],
      default: 2,
    });
  });

  // ── TS enum declarations ──

  it('numeric enum (auto-increment) → number + enumNames labels', () => {
    assert.deepEqual(schema.properties.level, {
      type: 'number',
      enum: [0, 1, 2],
      enumNames: ['Low', 'Medium', 'High'],
      default: 1,
    });
  });

  it('numeric enum with explicit start → continues from initializer', () => {
    assert.deepEqual(schema.properties.rank, {
      type: 'number',
      enum: [1, 2, 3],
      enumNames: ['First', 'Second', 'Third'],
      default: 1,
    });
  });

  it('string enum where member names match values → omits enumNames', () => {
    // `enum Color { red = 'red', green = 'green', blue = 'blue' }`
    assert.deepEqual(schema.properties.color, {
      type: 'string',
      enum: ['red', 'green', 'blue'],
      default: 'red',
    });
  });

  it('string enum where member names differ from values → adds enumNames', () => {
    // `enum Direction { North = 'N', South = 'S', East = 'E', West = 'W' }`
    assert.deepEqual(schema.properties.direction, {
      type: 'string',
      enum: ['N', 'S', 'E', 'W'],
      enumNames: ['North', 'South', 'East', 'West'],
      default: 'N',
    });
  });

  // ── Arrays ──

  it('typed array string[]', () => {
    assert.deepEqual(schema.properties.tags, {
      type: 'array',
      items: { type: 'string' },
      default: [],
    });
  });

  it('typed array number[]', () => {
    assert.deepEqual(schema.properties.scores, {
      type: 'array',
      items: { type: 'number' },
      default: [],
    });
  });

  it('array of inline objects', () => {
    const p = schema.properties.items;
    assert.equal(p.type, 'array');
    assert.deepEqual(p.items.properties, { name: { type: 'string' }, value: { type: 'number' } });
    assert.deepEqual(p.items.required, ['name', 'value']);
  });

  it('Array<T> generic syntax', () => {
    assert.deepEqual(schema.properties.history, {
      type: 'array',
      items: { type: 'string' },
      default: [],
    });
  });

  it('array of type alias resolves to object schema', () => {
    const p = schema.properties.changelog;
    assert.equal(p.type, 'array');
    assert.deepEqual(p.items.properties, {
      action: { type: 'string' },
      actor: { type: 'string' },
      ts: { type: 'number' },
    });
    assert.deepEqual(p.items.required, ['action', 'actor', 'ts']);
  });

  it('array with default values', () => {
    assert.deepEqual(schema.properties.defaultArr.default, ['a', 'b']);
  });

  // ── Optional fields ──

  it('optional string is not in required', () => {
    assert.ok(!schema.required.includes('description'));
    assert.equal(schema.properties.description.type, 'string');
  });

  it('optional object is not in required', () => {
    assert.ok(!schema.required.includes('metadata'));
    assert.equal(schema.properties.metadata.type, 'object');
  });

  // ── Inline objects ──

  it('nested object with defaults', () => {
    const c = schema.properties.config;
    assert.equal(c.type, 'object');
    assert.deepEqual(c.properties.nested, {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    });
    assert.deepEqual(c.default, { color: 'blue', opacity: 1, nested: { x: 0, y: 0 } });
  });

  it('object with default', () => {
    assert.deepEqual(schema.properties.defaultObj.default, { x: 10 });
  });

  // ── Record ──

  it('Record<string, unknown> → object', () => {
    assert.deepEqual(schema.properties.attrs, { type: 'object', default: {} });
  });

  // ── Boolean union collapses ──

  it('true | false → boolean', () => {
    assert.deepEqual(schema.properties.flag, { type: 'boolean', default: true });
  });

  // ── Nullable ──

  it('string | undefined → string (not in required)', () => {
    assert.equal(schema.properties.nickname.type, 'string');
    assert.ok(!schema.required.includes('nickname'));
  });

  // ── Mixed union → anyOf ──

  it('string | number → anyOf', () => {
    assert.deepEqual(schema.properties.value.anyOf, [{ type: 'string' }, { type: 'number' }]);
  });

  // ── bigint ──

  it('bigint → integer', () => {
    assert.equal(schema.properties.bigId.type, 'integer');
    assert.equal(schema.properties.bigId.default, 0);
  });

  // ── Date types ──

  it('@format date-time on string', () => {
    assert.equal(schema.properties.createdAt.format, 'date-time');
  });

  it('@format date on string', () => {
    assert.equal(schema.properties.birthday.format, 'date');
  });

  it('Date type → string format date-time', () => {
    assert.equal(schema.properties.dueDate.type, 'string');
    assert.equal(schema.properties.dueDate.format, 'date-time');
    assert.ok(!schema.required.includes('dueDate'));
  });

  // ── JSDoc annotations ──

  it('@format email', () => {
    assert.equal(schema.properties.email.format, 'email');
  });

  it('multiline JSDoc with @format', () => {
    assert.equal(schema.properties.phone.format, 'tel');
    assert.equal(schema.properties.phone.title, 'Contact phone number');
  });

  it('@hidden excludes property from schema', () => {
    assert.ok(!('internalSecret' in schema.properties));
    assert.ok(!schema.required.includes('internalSecret'));
  });

  it('@refType sets refType field', () => {
    assert.equal(schema.properties.linkedWidget.refType, 'test.schema-widget');
  });

  it('@format textarea', () => {
    assert.equal(schema.properties.notes.format, 'textarea');
  });

  it('@format path', () => {
    assert.equal(schema.properties.targetPath.format, 'path');
  });

  it('@format tags on array', () => {
    assert.equal(schema.properties.categories.format, 'tags');
    assert.equal(schema.properties.categories.type, 'array');
  });

  it('@format color', () => {
    assert.equal(schema.properties.accentColor.format, 'color');
  });

  it('@format uri', () => {
    assert.equal(schema.properties.homepage.format, 'uri');
  });

  it('@format password', () => {
    assert.equal(schema.properties.apiKey.format, 'password');
  });

  it('multiple tags on one line: @title + @description', () => {
    // Regression: parser used to greedily consume the whole line into the first tag,
    // yielding title = "Display Name @description The human-readable name shown in UI"
    // and no description at all.
    assert.equal(schema.properties.displayName.title, 'Display Name');
    assert.equal(
      schema.properties.displayName.description,
      'The human-readable name shown in UI',
    );
  });

  // ── Methods ──

  it('method with no args', () => {
    const m = schema.methods.increment;
    assert.deepEqual(m.arguments, []);
    assert.equal(m.title, 'Widget action — increment the counter.');
    assert.equal(m.description, 'Adds one vote to the current count.');
  });

  it('@pre/@post on methods', () => {
    assert.deepEqual(schema.methods.increment.pre, ['count']);
    assert.deepEqual(schema.methods.increment.post, ['count']);
  });

  it('method with typed arg', () => {
    const m = schema.methods.rename;
    assert.equal(m.arguments.length, 1);
    assert.equal(m.arguments[0].name, 'newTitle');
    assert.equal(m.arguments[0].type, 'string');
  });

  it('method with multiple args and @description', () => {
    const m = schema.methods.addTag;
    assert.equal(m.arguments.length, 2);
    assert.equal(m.description, 'Appends tag to the list');
  });

  it('method with object arg and inline JSDoc on properties', () => {
    const m = schema.methods.configure;
    assert.equal(m.arguments[0].type, 'object');
    assert.equal(m.arguments[0].properties.color.title, 'CSS color value');
    assert.equal(m.arguments[0].properties.opacity.title, '0-1 range');
  });

  it('generator → streaming with yields', () => {
    const m = schema.methods.watch;
    assert.equal(m.streaming, true);
    assert.deepEqual(m.yields, { type: 'string' });
  });

  it('method with multiple @pre/@post fields', () => {
    assert.deepEqual(schema.methods.reset.pre, ['count', 'scores']);
    assert.deepEqual(schema.methods.reset.post, ['count', 'scores', 'tags']);
    assert.equal(schema.methods.reset.description, 'Clears all accumulated data');
  });

  it('_underscore methods are excluded', () => {
    assert.ok(!('_cleanup' in schema.methods));
  });

  // ── Required fields ──

  it('non-optional fields are in required', () => {
    for (const name of ['title', 'count', 'enabled', 'status', 'tags', 'config', 'bigId']) {
      assert.ok(schema.required.includes(name), `${name} should be required`);
    }
  });

  it('optional fields are not in required', () => {
    for (const name of ['description', 'metadata', 'dueDate', 'linkedWidget', 'nickname']) {
      assert.ok(!schema.required.includes(name), `${name} should not be required`);
    }
  });

  // ── Cross-file type imports (with name collision) ──

  it('resolves imported type alias across files', () => {
    // Both widgets import `Entry` from different files — regression for
    // f1135ce which broke cross-file resolution by scoping aliases per file.
    assert.equal(alphaSchema.properties.entries.type, 'array');
    assert.equal(alphaSchema.properties.entries.items.type, 'object');
    assert.deepEqual(alphaSchema.properties.entries.items.properties, {
      kind: { type: 'string', enum: ['alpha'] },
      count: { type: 'number' },
    });
  });

  it('same-name type in different files resolves independently (no collision)', () => {
    assert.equal(betaSchema.properties.entries.type, 'array');
    assert.equal(betaSchema.properties.entries.items.type, 'object');
    assert.deepEqual(betaSchema.properties.entries.items.properties, {
      label: { type: 'string' },
      active: { type: 'boolean' },
    });
    // Neither widget should leak the other's shape.
    assert.ok(!('kind' in betaSchema.properties.entries.items.properties));
    assert.ok(!('label' in alphaSchema.properties.entries.items.properties));
  });

  it('cross-file enum import: type + Enum.Member default both resolve', () => {
    // `mode: Mode = Mode.Fast` where Mode is imported from entries-beta.ts.
    // Exercises lookupType() for the TSTypeReference and resolveEnum() for
    // the default value expression.
    assert.deepEqual(alphaSchema.properties.mode, {
      type: 'number',
      enum: [0, 1, 2],
      enumNames: ['Normal', 'Fast', 'Slow'],
      default: 1,
    });
  });

  it('resolves same-named registered class refs by import source', () => {
    assert.deepEqual(refSourceSchema.properties.alpha, {
      type: 'string',
      format: 'path',
      refType: 'test.ref-target-alpha',
    });
    assert.deepEqual(refSourceSchema.properties.beta, {
      type: 'string',
      format: 'path',
      refType: 'test.ref-target-beta',
    });
  });

  it('does not warn when same-named classes are registered in different files', () => {
    assert.deepEqual(
      warnings.filter((line) => line.includes('class name collision')),
      [],
    );
  });

  // ── Incremental: second run is no-op ──

  it('second run produces identical output', async () => {
    const before = await fs.readFile(SCHEMA_FILE, 'utf-8');
    const stat1 = await fs.stat(SCHEMA_FILE);

    // Small delay so mtime would differ if file were rewritten
    await new Promise((r) => setTimeout(r, 50));
    await generateSchemas([import.meta.dirname]);

    const after = await fs.readFile(SCHEMA_FILE, 'utf-8');
    const stat2 = await fs.stat(SCHEMA_FILE);

    assert.equal(before, after);
    assert.equal(stat1.mtimeMs, stat2.mtimeMs, 'file should not be rewritten when unchanged');
  });
});

describe('extract-schemas-oxc: merged enum rejection', () => {
  // Dynamic fixture dir — must be outside schema/ to avoid being scanned by the main test.
  // Created/destroyed per test run.
  const FIXTURE_DIR = path.join(IMPORT_FIXTURES_DIR, '_merged-enum');

  after(async () => {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('throws on duplicate enum declaration in the same file', async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(FIXTURE_DIR, 'bad-enum.ts'),
      `enum Status { Active, Inactive }\nenum Status { Pending }\n`,
    );

    await assert.rejects(
      () => generateSchemas([FIXTURE_DIR]),
      (err: Error) => err.message.includes('declared more than once'),
    );
  });
});
