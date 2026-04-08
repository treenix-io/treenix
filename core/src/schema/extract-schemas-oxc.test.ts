import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { generateSchemas } from '#schema/extract-schemas-oxc';

const SCHEMAS_DIR = path.resolve(import.meta.dirname, 'schemas');
const SCHEMA_FILE = path.join(SCHEMAS_DIR, 'test.schema-widget.json');

describe('extract-schemas-oxc', () => {
  let schema: any;

  before(async () => {
    // Clean previous test artifact
    await fs.rm(SCHEMA_FILE, { force: true });

    // Generate from fixture
    await generateSchemas([import.meta.dirname]);

    schema = JSON.parse(await fs.readFile(SCHEMA_FILE, 'utf-8'));
  });

  after(async () => {
    await fs.rm(SCHEMA_FILE, { force: true });
  });

  it('sets $id and $schema', () => {
    assert.equal(schema.$id, 'test.schema-widget');
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  });

  it('extracts class-level JSDoc as title', () => {
    assert.equal(schema.title, 'A complex widget for testing schema extraction');
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
      type: 'string', enum: ['draft', 'active', 'archived'], default: 'draft',
    });
  });

  it('string union with 3 values', () => {
    assert.deepEqual(schema.properties.priority, {
      type: 'string', enum: ['low', 'medium', 'high'], default: 'medium',
    });
  });

  // ── Arrays ──

  it('typed array string[]', () => {
    assert.deepEqual(schema.properties.tags, {
      type: 'array', items: { type: 'string' }, default: [],
    });
  });

  it('typed array number[]', () => {
    assert.deepEqual(schema.properties.scores, {
      type: 'array', items: { type: 'number' }, default: [],
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
      type: 'array', items: { type: 'string' }, default: [],
    });
  });

  it('array of type alias resolves to object schema', () => {
    const p = schema.properties.changelog;
    assert.equal(p.type, 'array');
    assert.deepEqual(p.items.properties, {
      action: { type: 'string' }, actor: { type: 'string' }, ts: { type: 'number' },
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
      type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } },
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
    assert.deepEqual(schema.properties.value.anyOf, [
      { type: 'string' }, { type: 'number' },
    ]);
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

  // ── Methods ──

  it('method with no args', () => {
    const m = schema.methods.increment;
    assert.deepEqual(m.arguments, []);
    assert.equal(m.title, 'Widget action — increment the counter.');
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

  // ── Incremental: second run is no-op ──

  it('second run produces identical output', async () => {
    const before = await fs.readFile(SCHEMA_FILE, 'utf-8');
    const stat1 = await fs.stat(SCHEMA_FILE);

    // Small delay so mtime would differ if file were rewritten
    await new Promise(r => setTimeout(r, 50));
    await generateSchemas([import.meta.dirname]);

    const after = await fs.readFile(SCHEMA_FILE, 'utf-8');
    const stat2 = await fs.stat(SCHEMA_FILE);

    assert.equal(before, after);
    assert.equal(stat1.mtimeMs, stat2.mtimeMs, 'file should not be rewritten when unchanged');
  });
});
