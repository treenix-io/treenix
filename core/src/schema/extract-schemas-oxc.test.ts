import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { generateSchemas, SchemaParseError } from '#schema/extract-schemas-oxc';
import type { TypeSchema } from '#schema/types';

const IMPORT_FIXTURES_DIR = path.resolve(import.meta.dirname, '_import-fixtures');

// Generation writes schemas/ next to its sources, and the schema loader tests read every schemas/ dir under
// src while running in parallel — so every run works on a copy outside the source tree.
const scratchDir = (name: string) => fs.mkdtemp(path.join(tmpdir(), `treenix-oxc-${name}-`));

describe('extract-schemas-oxc', () => {
  let fixturesDir: string;
  let schemaFile: string;
  let schema: any;
  let exportedSchema: any;
  let alphaSchema: any;
  let betaSchema: any;
  let refSourceSchema: any;
  let warnings: string[];

  before(async () => {
    fixturesDir = await scratchDir('fixtures');
    await fs.cp(IMPORT_FIXTURES_DIR, fixturesDir, { recursive: true });
    const schemasDir = path.join(fixturesDir, 'schemas');
    schemaFile = path.join(schemasDir, 'test.schema-widget.json');

    // Generate from fixture
    warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      await generateSchemas([fixturesDir]);
    } finally {
      console.warn = originalWarn;
    }

    const read = async (file: string) => JSON.parse(await fs.readFile(path.join(schemasDir, file), 'utf-8'));
    schema = await read('test.schema-widget.json');
    exportedSchema = await read('test.exported-schema-widget.json');
    alphaSchema = await read('test.import-collision-alpha.json');
    betaSchema = await read('test.import-collision-beta.json');
    refSourceSchema = await read('test.ref-source.json');
  });

  after(async () => {
    await fs.rm(fixturesDir, { recursive: true, force: true });
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

  it('negative numeric literal union → number enum with negative values', () => {
    // Regression C12: `-1` parses as UnaryExpression, not Literal — used to
    // corrupt the union into an empty/anyOf shape.
    assert.deepEqual(schema.properties.bias, {
      type: 'number',
      enum: [-1, 0, 1],
      default: 0,
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

  it('@pre is a sift query and @post update operators per target', () => {
    assert.deepEqual(schema.methods.increment.pre, { 'node.count': { $gte: 0 } });
    assert.deepEqual(schema.methods.increment.post, { '': { $inc: { count: 1 } } });
  });

  it('method with typed arg', () => {
    const m = schema.methods.rename;
    assert.equal(m.arguments.length, 1);
    assert.equal(m.arguments[0].name, 'newTitle');
    assert.equal(m.arguments[0].type, 'string');
  });

  it('method with one object argument and @description', () => {
    const m = schema.methods.addTag;
    assert.equal(m.arguments.length, 1);
    assert.equal(m.arguments[0].type, 'object');
    assert.deepEqual(m.arguments[0].required, ['tag', 'prio']);
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

  it('@pre and @post JSON spanning several lines', () => {
    assert.deepEqual(schema.methods.reset.pre, { 'node.count': { $gt: 0 }, 'node.scores': { $exists: true } });
    assert.deepEqual(schema.methods.reset.post, { '': { $set: { count: 0, scores: [] }, $unset: { tags: true } } });
    assert.equal(schema.methods.reset.description, 'Clears all accumulated data');
  });

  it('@setuid on a method → kind="setuid"', () => {
    assert.equal(schema.methods.archive.kind, 'setuid');
    assert.deepEqual(schema.methods.archive.post, { '': { $set: { status: 'archived' } } });
  });

  it('@version, @actionsOnly and @alias on the class', () => {
    assert.equal(schema.version, 3);
    assert.equal(schema.actionsOnly, true);
    assert.deepEqual(schema.aliases, ['test.old-widget', 'test.legacy-widget']);
    assert.equal(exportedSchema.version, undefined);
    assert.equal(exportedSchema.actionsOnly, undefined);
    assert.equal(exportedSchema.aliases, undefined);
  });

  it('_underscore methods are excluded', () => {
    assert.ok(!('_cleanup' in schema.methods));
  });

  it('union return type → anyOf in method schema', () => {
    // Regression C33: anyOf-shaped returns have no .type and were dropped.
    assert.deepEqual(schema.methods.lookup.return, {
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('union return type on arrow-field method → anyOf', () => {
    assert.deepEqual(schema.methods.peekArrow.return, {
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('@param/@returns/@throws do not leak into method schema', () => {
    // Regression C34: standard positional JSDoc is signature documentation,
    // not schema metadata.
    const m = schema.methods.lookup;
    assert.equal(m.title, 'Look up a value by key.');
    assert.ok(!('param' in m));
    assert.ok(!('returns' in m));
    assert.ok(!('throws' in m));
  });

  // ── Arrow-field methods (PropertyDefinition with arrow initializer) ──

  it('arrow-field with @read extracts kind="read" into methods', () => {
    assert.equal(schema.methods.shipArrow.kind, 'read');
    assert.ok(!('shipArrow' in schema.properties), 'arrow-field method should not appear in properties');
  });

  it('arrow-field with @write extracts kind="write"', () => {
    assert.equal(schema.methods.bumpArrow.kind, 'write');
  });

  it('arrow-field with @read @io extracts kind="read" io=true', () => {
    assert.equal(schema.methods.fetchExternal.kind, 'read');
    assert.equal(schema.methods.fetchExternal.io, true);
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
    const before = await fs.readFile(schemaFile, 'utf-8');
    // A past mtime: a rewrite, however fast, would move it.
    const past = new Date(1_000_000_000_000);
    await fs.utimes(schemaFile, past, past);

    await generateSchemas([fixturesDir]);

    assert.equal(await fs.readFile(schemaFile, 'utf-8'), before);
    assert.equal((await fs.stat(schemaFile)).mtimeMs, past.getTime(), 'file should not be rewritten when unchanged');
  });
});

describe('extract-schemas-oxc: parse errors', () => {
  let fixtureDir: string;

  after(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('throws SchemaParseError carrying the file path on syntax error', async () => {
    fixtureDir = await scratchDir('bad-parse');
    const badFile = path.join(fixtureDir, 'broken.ts');
    await fs.writeFile(badFile, 'export class Broken {\n  foo( {\n');

    await assert.rejects(
      () => generateSchemas([fixtureDir]),
      (err: unknown) => err instanceof SchemaParseError && err.file === badFile,
    );
  });
});

describe('extract-schemas-oxc: action and type rules', () => {
  const dirs: string[] = [];

  after(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  // Generation from one source file must fail with a SchemaParseError naming that file.
  async function refused(source: string): Promise<void> {
    const dir = await scratchDir('rule');
    dirs.push(dir);
    const file = path.join(dir, 'source.ts');
    await fs.writeFile(file, source);

    await assert.rejects(
      () => generateSchemas([dir]),
      (err: unknown) => err instanceof SchemaParseError && err.file === file,
    );
  }

  // Generation from one source file; returns the schema written for test.sample.
  async function generated(source: string): Promise<TypeSchema> {
    const dir = await scratchDir('rule');
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'source.ts'), source);
    await generateSchemas([dir]);
    return JSON.parse(await fs.readFile(path.join(dir, 'schemas', 'test.sample.json'), 'utf-8'));
  }

  const registered = (body: string, classDoc = '') =>
    `${classDoc}\nclass Sample {\n${body}\n}\nregisterType('test.sample', Sample);\n`;

  it("a class method's second parameter is the injected needs, left out of the arguments", async () => {
    const schema = await generated(registered(
      `run(tag: string, deps: { order: { status: string } }) {}\nship = (tag: string, deps: unknown) => tag;`,
    ));

    assert.deepEqual(schema.methods?.run?.arguments, [{ name: 'tag', type: 'string' }]);
    assert.deepEqual(schema.methods?.ship?.arguments, [{ name: 'tag', type: 'string' }]);
  });

  it("a register()ed handler's args type is read through a default value", async () => {
    const schema = await generated(`register('test.sample', 'action:run', (ctx: unknown, params: { n?: number } = {}) => params);\n`);

    assert.deepEqual(schema.methods?.run?.arguments, [{ name: 'params', type: 'object', properties: { n: { type: 'number' } } }]);
  });

  it('a streaming method with @post fails', async () => {
    await refused(registered(`/** @post {"": {"$set": {"a": 1}}} */\nasync *run(): AsyncGenerator<string> { yield '' }`));
  });

  it('a legacy @pre field list fails, naming the file', async () => {
    await refused(registered(`/** @pre count scores */\nrun() {}`));
  });

  it('a class method with a parameter after the needs fails', async () => {
    await refused(registered(`run(tag: string, deps: unknown, prio: number) {}`));
  });

  it('an arrow-field method with a parameter after the needs fails', async () => {
    await refused(registered(`run = (tag: string, deps: unknown, prio: number) => tag;`));
  });

  it('a rest parameter fails', async () => {
    await refused(registered(`run(...tags: string[]) {}`));
    await refused(registered(`run(tag: string, ...deps: unknown[]) {}`));
  });

  it('a register()ed action handler with two data parameters fails', async () => {
    await refused(`register('test.sample', 'action:run', (ctx: unknown, tag: string, prio: number) => tag);\n`);
  });

  it('a @read method with @post fails', async () => {
    await refused(registered(`/** @read @post {"": {"$set": {"a": 1}}} */\nrun() {}`));
  });

  it('a type tag on a method fails', async () => {
    await refused(registered(`/** @version 2 */\nrun() {}`));
    await refused(registered(`/** @actionsOnly */\nrun() {}`));
  });

  it('an action tag on a class fails', async () => {
    await refused(registered(`name = '';`, '/** @read */'));
    await refused(registered(`name = '';`, '/** @pre {"node.name": "x"} */'));
  });

  it('an action or type tag on a field fails', async () => {
    await refused(registered(`/** @io */\nname = '';`));
    await refused(registered(`/** @alias test.old */\nname = '';`));
    await refused(registered(`opts: { /** @post {} */ color?: string } = {};`));
  });

  it('a type naming itself in @alias fails', async () => {
    await refused(registered(`name = '';`, '/** @alias test.sample */'));
  });

  it('a directory that cannot be read fails the run', async () => {
    const missing = path.join(await scratchDir('missing'), 'absent');
    dirs.push(path.dirname(missing));

    await assert.rejects(() => generateSchemas([missing]), (err: unknown) => err instanceof Error && 'code' in err && err.code === 'ENOENT');
  });
});

describe('extract-schemas-oxc: merged enum rejection', () => {
  let fixtureDir: string;

  after(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('throws on duplicate enum declaration in the same file', async () => {
    fixtureDir = await scratchDir('merged-enum');
    await fs.writeFile(
      path.join(fixtureDir, 'bad-enum.ts'),
      `enum Status { Active, Inactive }\nenum Status { Pending }\n`,
    );

    await assert.rejects(
      () => generateSchemas([fixtureDir]),
      (err: Error) => err.message.includes('declared more than once'),
    );
  });
});
