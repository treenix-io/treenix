// Schema extraction using OXC parser (Rust, ~20ms for 250 files)

import { parseSync } from 'oxc-parser';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertValidType } from '#core/json';
import { KernelError } from '#errors';
import { assertSafeSiftQuery } from '#kernel/expr';
import { assertPost } from '#kernel/post';
import { DEFAULT_LIMITS, type Post, type Where } from '#kernel/types';
import type { ActionKind, MethodArgSchema, MethodSchema, PropertySchema, TypeSchema } from '#schema/types';

interface ComponentEntry {
  typeName: string;
  className: string;
  fileName: string;
}
interface ExternalAction {
  name: string;
  description?: string;
  arguments?: MethodArgSchema[];
  fileName: string;
}

type N = Record<string, any>;
type Comment = { type: string; value: string; start: number; end: number };

// ── JSDoc ──

class JSDocError extends Error {
  override readonly name = 'JSDocError';
}

// Parse failures must break the run (C11): a file that silently contributes
// nothing yields stale/missing schemas that look like extractor bugs downstream.
export class SchemaParseError extends Error {
  override readonly name = 'SchemaParseError';
  constructor(
    message: string,
    readonly file: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// Whitelist of allowed JSDoc tags. Unknown tags throw to catch typos.
// Module-specific tags can use the `@x-foo` escape (Phase 1.2).
const KNOWN_TAGS = new Set([
  // identity / docs
  'title', 'description', 'deprecated', 'internal', 'example', 'see',
  // schema annotations
  'format', 'refType', 'hidden', 'opaque', 'dangerous',
  // method kind
  'read', 'write', 'setuid', 'io',
  // dataflow contract
  'pre', 'post',
  // type identity and evolution
  'version', 'actionsOnly', 'alias',
  // standard JSDoc — @param/@returns/@throws allowed but stripped before return
  // (positional signature docs, not schema metadata); @default is kept
  'param', 'returns', 'throws', 'default',
]);

// C34: @param/@returns/@throws describe the TS signature, which is already
// the source of truth for arguments/return — leaking them corrupts schemas.
const SIGNATURE_TAGS = new Set(['param', 'returns', 'throws']);

// Tags the extractor reads into typed schema fields; every other known tag is an annotation carried as written.
const INTERPRETED_TAGS = new Set(['read', 'write', 'setuid', 'io', 'pre', 'post', 'version', 'actionsOnly', 'alias']);

// A JSON value may span lines: it runs to the next tag line.
const JSON_TAGS = new Set(['pre', 'post']);

const ACTION_KINDS: readonly ActionKind[] = ['read', 'write', 'setuid'];

// Parse JSDoc comment body into a tag map.
// Line-oriented:
//   - If a line's first non-whitespace char is NOT `@` → prose. Embedded
//     `@word` (e.g. `(see @treenx/core)` or `test @treenx`) is text, not a tag.
//     First prose line becomes implicit title; rest joins description.
//   - If a line starts with `@` → tag-line. Multiple tags allowed:
//     `@title Foo @format bar`, or `@read @io` (combined kind+modifier).
// Tag name: letter-led, allows digits/underscore/hyphen for `@x-foo` escape.
export interface ParsedJSDoc {
  /** Carried into the schema as written. */
  annotations: Record<string, string>;
  kind?: ActionKind;
  io?: true;
  pre?: Where;
  post?: Post;
  version?: number;
  actionsOnly?: true;
  aliases?: string[];
}

export function parseJSDoc(raw: string): ParsedJSDoc {
  const annotations: Record<string, string> = {};
  const interpreted = new Map<string, string[]>();
  if (!raw) return { annotations };
  const plainDescriptionParts: string[] = [];
  let hasExplicitDescription = false;
  let openJson: string[] | undefined;

  const lines = raw
    .replace(/^\s*\*\s?/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Prose-line: first non-WS char is not `@`. Embedded `@word` is text.
    if (!line.startsWith('@')) {
      if (openJson) openJson[openJson.length - 1] += ' ' + line;
      else if (!annotations.title) annotations.title = line;
      else plainDescriptionParts.push(line);
      continue;
    }
    openJson = undefined;

    // Tag-line: parse all `@tag` instances on this line.
    const tagRe = /(?:^|\s)@([a-zA-Z][\w-]*)/g;
    const hits: Array<{ idx: number; name: string; valueStart: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(line))) {
      const at = m.index + m[0].indexOf('@');
      hits.push({ idx: at, name: m[1], valueStart: at + 1 + m[1].length });
    }

    for (let i = 0; i < hits.length; i++) {
      const { name, valueStart } = hits[i];
      const end = i + 1 < hits.length ? hits[i + 1].idx : line.length;
      const value = line.slice(valueStart, end).trim();
      if (!KNOWN_TAGS.has(name) && !name.startsWith('x-')) {
        throw new JSDocError(`Unknown JSDoc tag: @${name}`);
      }
      if (SIGNATURE_TAGS.has(name)) continue;

      if (INTERPRETED_TAGS.has(name)) {
        const values = interpreted.get(name) ?? [];
        values.push(value);
        interpreted.set(name, values);
        if (JSON_TAGS.has(name) && i === hits.length - 1) openJson = values;
        continue;
      }

      if (name === 'description') hasExplicitDescription = true;
      annotations[name] = value;
    }
  }

  if (!hasExplicitDescription && plainDescriptionParts.length) {
    annotations.description = plainDescriptionParts.join(' ');
  }
  if (annotations.description === annotations.title) {
    delete annotations.description;
  }

  return { annotations, ...interpretTags(interpreted) };
}

function interpretTags(tags: Map<string, string[]>): Omit<ParsedJSDoc, 'annotations'> {
  const doc: Omit<ParsedJSDoc, 'annotations'> = {};

  const kinds = ACTION_KINDS.filter((kind) => tags.has(kind));
  if (kinds.length > 1) {
    throw new JSDocError(`Conflicting kind tags: ${kinds.map((k) => '@' + k).join(' ')}`);
  }
  if (kinds.length) doc.kind = kinds[0];
  if (tags.has('io')) doc.io = true;

  // A value would read as a setting, and `@actionsOnly false` must not mean true.
  const actionsOnly = tags.get('actionsOnly');
  if (actionsOnly?.some(Boolean)) throw new JSDocError(`@actionsOnly takes no value, got: ${actionsOnly.join(' ')}`);
  if (actionsOnly) doc.actionsOnly = true;

  const version = single(tags, 'version');
  if (version !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(version) || !Number.isSafeInteger(Number(version)))
      throw new JSDocError(`@version takes a non-negative integer, got: ${version}`);
    doc.version = Number(version);
  }

  const aliases = tags.get('alias')?.flatMap((value) => value.split(/\s+/).filter(Boolean));
  if (aliases) doc.aliases = typeNames(aliases);

  const pre = single(tags, 'pre');
  if (pre !== undefined) {
    doc.pre = jsonTag('pre', pre, (q): Where => {
      assertSafeSiftQuery(q, DEFAULT_LIMITS);
      return q;
    });
  }

  const post = single(tags, 'post');
  if (post !== undefined) {
    doc.post = jsonTag('post', post, (p): Post => {
      assertPost(p);
      return p;
    });
  }

  return doc;
}

// A second value of a one-value tag would silently replace the first.
function single(tags: Map<string, string[]>, name: string): string | undefined {
  const values = tags.get(name);
  if (values && values.length > 1) throw new JSDocError(`@${name} is given ${values.length} times`);
  return values?.[0];
}

function typeNames(names: string[]): string[] {
  if (!names.length) throw new JSDocError('@alias takes the earlier type names');
  if (new Set(names).size < names.length) throw new JSDocError(`@alias repeats a name: ${names.join(' ')}`);

  for (const name of names) {
    try {
      assertValidType(name);
    } catch (e) {
      throw new JSDocError(`@alias ${name} is not a type name`, { cause: e });
    }
  }
  return names;
}

// A JSON tag holds what the kernel accepts at run time: @pre a sift query it can evaluate, @post a Post.
function jsonTag<T>(tag: string, text: string, check: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new JSDocError(`@${tag} takes JSON — a list of field names is not one: ${text}`, { cause: e });
  }

  try {
    return check(value);
  } catch (e) {
    if (!(e instanceof KernelError)) throw e;
    throw new JSDocError(`@${tag} ${text}: ${e.message}`, { cause: e });
  }
}

// Tag errors name the file here: parseJSDoc sees one comment and cannot.
function parseFileJSDoc(raw: string, file: string): ParsedJSDoc {
  try {
    return parseJSDoc(raw);
  } catch (e) {
    if (!(e instanceof JSDocError)) throw e;
    throw new SchemaParseError(`[schema/oxc] ${file}: ${e.message}`, file, { cause: e });
  }
}

function buildJSDocMap(comments: Comment[], source: string, file: string): Map<number, ParsedJSDoc> {
  const map = new Map<number, ParsedJSDoc>();
  for (const c of comments) {
    if (c.type !== 'Block' || !c.value.startsWith('*')) continue;
    let pos = c.end;
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    const doc = parseFileJSDoc(c.value, file);
    map.set(pos, doc);

    // `export class Foo` often reports the ClassDeclaration start at `class`,
    // while the JSDoc naturally points at `export`. Map both positions.
    let classPos = pos;
    while (true) {
      while (classPos < source.length && /\s/.test(source[classPos])) classPos++;
      const keyword = /^(export|default|declare|abstract)\b/.exec(source.slice(classPos));
      if (!keyword) break;
      classPos += keyword[0].length;
    }
    while (classPos < source.length && /\s/.test(source[classPos])) classPos++;
    if (source.startsWith('class', classPos)) map.set(classPos, doc);
  }
  return map;
}

// ── Type → JSON Schema ──

interface ImportEntry {
  importedName: string; // name as exported from source file
  sourceFile: string; // absolute path
}

interface FileDocs {
  file: string;
  at: Map<number, ParsedJSDoc>;
}

// Interpreted tags mean something only where they are read — kinds and contracts on an action, identity and
// evolution on a type. Anywhere else they would be dropped while their author believes they hold.
const ACTION_FIELDS = ['kind', 'io', 'pre', 'post'] as const;
const TYPE_FIELDS = ['version', 'actionsOnly', 'aliases'] as const;
const INTERPRETED_FIELDS = [...ACTION_FIELDS, ...TYPE_FIELDS];
type InterpretedField = (typeof INTERPRETED_FIELDS)[number];

const tagOf = (field: InterpretedField): string =>
  field === 'kind' ? '@read/@write/@setuid' : field === 'aliases' ? '@alias' : `@${field}`;

function assertNoTags(doc: ParsedJSDoc | undefined, fields: readonly InterpretedField[], where: string, file: string): void {
  const found = fields.filter((field) => doc?.[field] !== undefined);
  if (found.length) {
    throw new SchemaParseError(`[schema/oxc] ${file}: ${where} cannot carry ${found.map(tagOf).join(', ')}`, file);
  }
}

function fieldAnnotations(docs: FileDocs, pos: number, where: string): Record<string, string> | undefined {
  const doc = docs.at.get(pos);
  assertNoTags(doc, INTERPRETED_FIELDS, where, docs.file);
  return doc?.annotations;
}

interface SchemaCtx {
  docs?: FileDocs;
  // File-scoped aliases/enums: two modules may each define `type Entry = {...}` or `enum Status`
  // with different shapes. A global map silently corrupts whichever class is parsed second.
  aliasesByFile?: Map<string, Map<string, N>>;
  enumsByFile?: Map<string, Map<string, N>>;
  importsByFile?: Map<string, Map<string, ImportEntry>>;
  currentFile?: string; // active file scope for name lookups
  resolving?: Set<string>; // cycle guard keyed by "file::name"
}

// Lookup a type alias or enum by name in the current file's scope, following
// ES imports across file boundaries. Returns both the node and the file where
// it was defined, so callers can switch currentFile when recursing.
function lookupType(
  name: string,
  ctx: SchemaCtx,
): { kind: 'alias' | 'enum'; node: N; file: string } | undefined {
  const { currentFile } = ctx;
  if (!currentFile) return undefined;

  const localAlias = ctx.aliasesByFile?.get(currentFile)?.get(name);
  if (localAlias) return { kind: 'alias', node: localAlias, file: currentFile };

  const localEnum = ctx.enumsByFile?.get(currentFile)?.get(name);
  if (localEnum) return { kind: 'enum', node: localEnum, file: currentFile };

  const imp = ctx.importsByFile?.get(currentFile)?.get(name);
  if (!imp) return undefined;

  const importedAlias = ctx.aliasesByFile?.get(imp.sourceFile)?.get(imp.importedName);
  if (importedAlias) return { kind: 'alias', node: importedAlias, file: imp.sourceFile };

  const importedEnum = ctx.enumsByFile?.get(imp.sourceFile)?.get(imp.importedName);
  if (importedEnum) return { kind: 'enum', node: importedEnum, file: imp.sourceFile };

  return undefined;
}

// TS enum members: numeric by default (auto-incrementing from 0 or last explicit number),
// string if explicitly assigned a string literal. Complex constant expressions
// (`B = A + 1`, cross-member refs, computed members) are NOT supported — we fail loud
// rather than silently falling back to auto-increment, which would corrupt the schema.
function getEnumValues(enumNode: N): { name: string; value: string | number }[] {
  const members: N[] = enumNode.body?.members ?? [];
  const out: { name: string; value: string | number }[] = [];
  let auto = 0;
  for (const m of members) {
    const name = m.id?.name ?? m.key?.name;
    if (!name) continue;
    const init = m.initializer;
    if (init) {
      const v = evalInit(init);
      if (typeof v === 'number') {
        out.push({ name, value: v });
        auto = v + 1;
      } else if (typeof v === 'string') {
        out.push({ name, value: v });
      } else
        throw new Error(
          `[schema/oxc] unsupported enum initializer for member "${name}" in enum "${enumNode.id?.name ?? '?'}" — only literal strings/numbers are supported`,
        );
    } else {
      out.push({ name, value: auto++ });
    }
  }
  return out;
}

function enumToSchema(enumNode: N): PropertySchema {
  const entries = getEnumValues(enumNode);
  const values = entries.map((e) => e.value);
  const names = entries.map((e) => e.name);
  const allString = values.every((v) => typeof v === 'string');
  const allNumber = values.every((v) => typeof v === 'number');
  if (!allString && !allNumber)
    throw new Error(
      `[schema/oxc] heterogeneous enum "${enumNode.id?.name ?? '?'}" (mixed string/number members) is not supported`,
    );
  // enumNames provides UI labels for number enums (where runtime values are opaque) and
  // for string enums whose member names differ from their values. Non-standard extension
  // consumed by the schema-form editor.
  const namesDiffer = allString ? names.some((n, i) => n !== values[i]) : true;
  const base = allString
    ? { type: 'string' as const, enum: values }
    : { type: 'number' as const, enum: values };
  return namesDiffer ? { ...base, enumNames: names } : base;
}

// TS parses a negative literal type (`-1`) as UnaryExpression('-', Literal)
// inside TSLiteralType — unwrap it like evalInit does, otherwise negative
// members corrupt/empty the resulting enum (C12).
function literalTypeValue(literal: N | null | undefined): unknown {
  if (!literal) return undefined;
  if (
    literal.type === 'UnaryExpression' &&
    literal.operator === '-' &&
    literal.argument?.type === 'Literal' &&
    typeof literal.argument.value === 'number'
  )
    return -literal.argument.value;
  return literal.value;
}

// Interim fail-loud (core-2q1): unresolved type refs emit {}. Several current
// uses legitimately rely on that (same-file interfaces, Partial<T>, bare-package
// imports), so we aggregate into ONE warning per run instead of throwing.
const unresolvedRefs = new Set<string>();

function noteUnresolvedRef(name: string, ctx: SchemaCtx): PropertySchema {
  const file = ctx.currentFile ? path.relative(process.cwd(), ctx.currentFile) : 'unknown file';
  unresolvedRefs.add(`${name} (${file})`);
  return {};
}

// `{}` is the CORRECT schema for these keywords (any value / no value) —
// reporting them as "unresolved" would drown the real gaps in noise.
const INTENTIONALLY_EMPTY = new Set([
  'TSAnyKeyword',
  'TSUnknownKeyword',
  'TSVoidKeyword',
  'TSUndefinedKeyword',
  'TSNullKeyword',
  'TSNeverKeyword',
]);

function typeToSchema(node: N | null | undefined, ctx: SchemaCtx = {}): PropertySchema {
  if (!node) return {};

  switch (node.type) {
    case 'TSStringKeyword':
      return { type: 'string' };
    case 'TSNumberKeyword':
      return { type: 'number' };
    case 'TSBooleanKeyword':
      return { type: 'boolean' };
    case 'TSBigIntKeyword':
      return { type: 'integer' };

    case 'TSArrayType':
      return { type: 'array', items: typeToSchema(node.elementType, ctx) };

    case 'TSUnionType': {
      const types = node.types as N[];
      const lits = types.map((t) =>
        t.type === 'TSLiteralType' ? literalTypeValue(t.literal) : undefined,
      );
      if (lits.every((v): v is string => typeof v === 'string'))
        return { type: 'string', enum: lits };
      if (lits.every((v): v is number => typeof v === 'number'))
        return { type: 'number', enum: lits };
      if (lits.every((v) => typeof v === 'boolean')) return { type: 'boolean' };
      const nonUndef = types.filter((t) => t.type !== 'TSUndefinedKeyword');
      if (nonUndef.length === 1) return typeToSchema(nonUndef[0], ctx);
      return { anyOf: nonUndef.map((t) => typeToSchema(t, ctx)) };
    }

    case 'TSLiteralType': {
      const v = literalTypeValue(node.literal);
      if (typeof v === 'string') return { type: 'string', enum: [v] };
      if (typeof v === 'number') return { type: 'number', enum: [v] };
      if (typeof v === 'boolean') return { type: 'boolean' };
      return {};
    }

    case 'TSTypeLiteral': {
      const properties: Record<string, PropertySchema> = {};
      const required: string[] = [];
      for (const m of node.members ?? []) {
        if (m.type === 'TSPropertySignature' && m.key?.name) {
          properties[m.key.name] = typeToSchema(m.typeAnnotation?.typeAnnotation, ctx);
          if (ctx.docs) Object.assign(properties[m.key.name], fieldAnnotations(ctx.docs, m.start, `field ${m.key.name}`));
          if (!m.optional) required.push(m.key.name);
        }
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }

    case 'TSTypeReference': {
      const name = node.typeName?.name;
      const tparams = node.typeArguments?.params ?? node.typeParameters?.params;
      if (name === 'Date') return { type: 'string', format: 'date-time' };
      if (name === 'Record') return { type: 'object' };
      if (name === 'Array' && tparams?.[0])
        return { type: 'array', items: typeToSchema(tparams[0], ctx) };
      if (name === 'Promise' && tparams?.[0]) return typeToSchema(tparams[0], ctx);
      if ((name === 'AsyncGenerator' || name === 'Generator') && tparams?.[0])
        return typeToSchema(tparams[0], ctx);

      // Resolve type aliases and TS enums — local first, then follow ES imports
      // to the source file scope. Cycle guard is keyed by (file, name) so two
      // different files can share a type name without cross-contamination.
      if (name) {
        const found = lookupType(name, ctx);
        if (found) {
          if (found.kind === 'enum') return enumToSchema(found.node);
          const key = found.file + '::' + name;
          const resolving = ctx.resolving ?? new Set();
          if (resolving.has(key)) return {};
          resolving.add(key);
          const result = typeToSchema(found.node, {
            ...ctx,
            currentFile: found.file,
            resolving,
          });
          resolving.delete(key);
          return result;
        }
      }

      return noteUnresolvedRef(name ?? node.typeName?.type ?? node.type, ctx);
    }

    case 'TSTypeAnnotation':
      return typeToSchema(node.typeAnnotation, ctx);

    default:
      if (INTENTIONALLY_EMPTY.has(node.type)) return {};
      return noteUnresolvedRef(node.type, ctx);
  }
}

function typeFromInit(value: N | null | undefined): PropertySchema {
  if (!value) return {};
  if (value.type === 'Literal') {
    if (typeof value.value === 'string') return { type: 'string' };
    if (typeof value.value === 'number') return { type: 'number' };
    if (typeof value.value === 'boolean') return { type: 'boolean' };
  }
  if (value.type === 'ArrayExpression') return { type: 'array' };
  if (value.type === 'ObjectExpression') return { type: 'object' };
  return {};
}

// Resolve a MemberExpression target like `Level` in `Level.Medium` to its enum
// declaration, following file-local scope first and ES imports second. Returns
// undefined if the name isn't a known enum.
function resolveEnum(name: string, ctx: SchemaCtx): N | undefined {
  if (!ctx.currentFile) return undefined;
  const local = ctx.enumsByFile?.get(ctx.currentFile)?.get(name);
  if (local) return local;
  const imp = ctx.importsByFile?.get(ctx.currentFile)?.get(name);
  if (!imp) return undefined;
  return ctx.enumsByFile?.get(imp.sourceFile)?.get(imp.importedName);
}

function evalInit(node: N | null | undefined, ctx: SchemaCtx = {}): unknown {
  if (!node) return undefined;
  if (node.type === 'Literal')
    return typeof node.value === 'bigint' ? Number(node.value) : node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal')
    return -(node.argument.value as number);
  if (
    node.type === 'MemberExpression' &&
    node.object?.type === 'Identifier' &&
    node.property?.type === 'Identifier'
  ) {
    const enumNode = resolveEnum(node.object.name, ctx);
    if (enumNode) return getEnumValues(enumNode).find((e) => e.name === node.property.name)?.value;
  }
  if (node.type === 'ArrayExpression') {
    const arr: unknown[] = [];
    for (const el of node.elements ?? []) {
      const v = evalInit(el, ctx);
      if (v === undefined) return undefined;
      arr.push(v);
    }
    return arr;
  }
  if (node.type === 'ObjectExpression') {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties ?? []) {
      if (prop.type !== 'Property' || !prop.key?.name) return undefined;
      const v = evalInit(prop.value, ctx);
      if (v === undefined) return undefined;
      obj[prop.key.name] = v;
    }
    return obj;
  }
  return undefined;
}

// Sort object keys to keep JSON output stable across fs.readdir orders
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(obj).sort((a, b) => a.localeCompare(b)).map((k) => [k, obj[k]]),
  );
}

// ── AST walking ──

function walk(node: N, visitor: (n: N) => void) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((n) => walk(n, visitor));
    else if (typeof v === 'object' && v !== null) walk(v, visitor);
  }
}

const REGISTER_FNS = new Set(['defineComponent', 'registerType']);

function findRegistrations(ast: N, fileName: string): ComponentEntry[] {
  const entries: ComponentEntry[] = [];
  walk(ast, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      REGISTER_FNS.has(node.callee.name)
    ) {
      const [typeArg, classArg] = node.arguments ?? [];
      if (
        typeArg?.type === 'Literal' &&
        typeof typeArg.value === 'string' &&
        classArg?.type === 'Identifier'
      )
        entries.push({ typeName: typeArg.value, className: classArg.name, fileName });
    }
  });
  return entries;
}

function findClasses(ast: N): Map<string, N> {
  const classes = new Map<string, N>();
  walk(ast, (node) => {
    if (node.type === 'ClassDeclaration' && node.id?.name) classes.set(node.id.name, node);
  });
  return classes;
}

function findTypeAliases(ast: N): Map<string, N> {
  const aliases = new Map<string, N>();
  walk(ast, (node) => {
    if (node.type === 'TSTypeAliasDeclaration' && node.id?.name && node.typeAnnotation)
      aliases.set(node.id.name, node.typeAnnotation);
  });
  return aliases;
}

// ── Import resolution ──
// Cross-file type resolution needs to follow ES imports (relative paths and
// Node `imports` field aliases like `#log`). We walk ImportDeclaration nodes,
// resolve the source spec to an absolute file path, and build a per-file map
// of localName → (importedName, sourceFile) so same-name collisions across
// files stay isolated.

// Cache: dir → { dir, imports } walked to nearest package.json with an imports field.
// Null means "no imports field found above this dir".
const packageImportsCache = new Map<
  string,
  { dir: string; imports: Record<string, any> } | null
>();

async function findPackageImports(
  fromFile: string,
): Promise<{ dir: string; imports: Record<string, any> } | null> {
  let dir = path.dirname(fromFile);
  const visited: string[] = [];
  while (true) {
    const cached = packageImportsCache.get(dir);
    if (cached !== undefined) {
      for (const v of visited) packageImportsCache.set(v, cached);
      return cached;
    }
    visited.push(dir);

    const pkgPath = path.join(dir, 'package.json');
    let pkg: any = null;
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    } catch {}

    // Node ESM semantics: `imports` field is scoped to the nearest package.
    // Once we find a package.json, stop — do NOT walk past it looking for an
    // ancestor's imports, even if this package has no imports field itself.
    if (pkg) {
      const result =
        pkg.imports && typeof pkg.imports === 'object'
          ? { dir, imports: pkg.imports as Record<string, any> }
          : null;
      for (const v of visited) packageImportsCache.set(v, result);
      return result;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const v of visited) packageImportsCache.set(v, null);
      return null;
    }
    dir = parent;
  }
}

async function tryResolveFile(base: string): Promise<string | null> {
  // Candidates mirror what `globSourceFiles` actually scans (.ts only, not .tsx).
  // Resolving to a file that's never parsed would leave it absent from
  // aliasesByFile/enumsByFile and defeat the lookup anyway.
  // TS ESM rewrite: `./foo.js` specifiers map to `./foo.ts` source.
  let candidates: string[];
  const ext = path.extname(base);
  if (ext === '.ts') {
    candidates = [base];
  } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    candidates = [base.slice(0, -ext.length) + '.ts'];
  } else {
    candidates = [base + '.ts', path.join(base, 'index.ts')];
  }
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isFile()) return path.resolve(c);
    } catch {}
  }
  return null;
}

async function resolveImportSource(fromFile: string, source: string): Promise<string | null> {
  // Relative: ./foo, ../bar
  if (source.startsWith('.')) {
    return tryResolveFile(path.resolve(path.dirname(fromFile), source));
  }
  // Node `imports` field alias (e.g. `#log`)
  if (source.startsWith('#')) {
    const pkg = await findPackageImports(fromFile);
    if (!pkg) return null;
    for (const [pattern, target] of Object.entries(pkg.imports)) {
      const targetPath =
        typeof target === 'string' ? target : target?.development ?? target?.default;
      if (typeof targetPath !== 'string') continue;

      if (pattern === source) {
        return tryResolveFile(path.resolve(pkg.dir, targetPath));
      }
      if (pattern.endsWith('*') && targetPath.includes('*')) {
        const prefix = pattern.slice(0, -1);
        if (source.startsWith(prefix)) {
          const rest = source.slice(prefix.length);
          return tryResolveFile(path.resolve(pkg.dir, targetPath.replace('*', rest)));
        }
      }
    }
    return null;
  }
  // External package — not worth resolving for schema purposes
  return null;
}

async function findImports(ast: N, fileName: string): Promise<Map<string, ImportEntry>> {
  const imports = new Map<string, ImportEntry>();
  const pending: Array<{ localName: string; importedName: string; source: string }> = [];

  walk(ast, (node) => {
    if (node.type === 'ImportDeclaration' && typeof node.source?.value === 'string') {
      for (const spec of node.specifiers ?? []) {
        if (spec.type !== 'ImportSpecifier' || !spec.local?.name) continue;
        pending.push({
          localName: spec.local.name,
          importedName: spec.imported?.name ?? spec.local.name,
          source: node.source.value,
        });
      }
    }
  });

  for (const { localName, importedName, source } of pending) {
    const sourceFile = await resolveImportSource(fileName, source);
    if (sourceFile) imports.set(localName, { importedName, sourceFile });
  }
  return imports;
}

function findEnums(ast: N, fileName: string): Map<string, N> {
  const enums = new Map<string, N>();
  walk(ast, (node) => {
    if (node.type === 'TSEnumDeclaration' && node.id?.name) {
      if (enums.has(node.id.name)) {
        throw new Error(
          `[schema/oxc] enum "${node.id.name}" is declared more than once in ${fileName} — enum merging is not supported`,
        );
      }
      enums.set(node.id.name, node);
    }
  });
  return enums;
}

function findExternalActions(ast: N, fileName: string): Map<string, ExternalAction[]> {
  const byType = new Map<string, ExternalAction[]>();
  walk(ast, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'register' &&
      node.arguments?.length >= 3
    ) {
      const [typeArg, ctxArg, handlerArg] = node.arguments;
      if (
        typeArg?.type === 'Literal' &&
        typeof typeArg.value === 'string' &&
        ctxArg?.type === 'Literal' &&
        typeof ctxArg.value === 'string' &&
        ctxArg.value.startsWith('action:') &&
        !ctxArg.value.includes(':', 7)
      ) {
        const actionName = ctxArg.value.slice(7);
        if (actionName.startsWith('_')) return;

        if (!byType.has(typeArg.value)) byType.set(typeArg.value, []);
        const list = byType.get(typeArg.value)!;
        if (list.some((a) => a.name === actionName)) return;

        const action: ExternalAction = { name: actionName, fileName };

        // Extract handler param types (skip 1st ctx param)
        if (
          handlerArg?.type === 'ArrowFunctionExpression' ||
          handlerArg?.type === 'FunctionExpression'
        ) {
          const params: N[] = handlerArg.params ?? [];
          const args = actionArguments(params.slice(1), {}, `${typeArg.value}.${actionName}`, fileName);
          if (args.length) action.arguments = args;
        }

        list.push(action);
      }
    }
  });
  return byType;
}

// ── Schema generation ──

// TWP `act` carries one args value, so an action declares at most one data parameter; a rest parameter would take
// any number of them.
function actionArguments(params: N[], ctx: SchemaCtx, where: string, file: string): MethodArgSchema[] {
  if (params.length > 1) {
    throw new SchemaParseError(
      `[schema/oxc] ${file}: ${where} declares ${params.length} data parameters; an action takes one args value`,
      file,
    );
  }

  return params.map((param) => {
    if (param.type === 'RestElement') {
      throw new SchemaParseError(`[schema/oxc] ${file}: ${where} declares a rest parameter; an action takes one args value`, file);
    }
    const p = param.type === 'AssignmentPattern' ? param.left : param;
    return { name: p.name ?? 'arg', ...typeToSchema(p.typeAnnotation?.typeAnnotation, ctx) };
  });
}

function buildClassTypesByFile(entries: ComponentEntry[]): Map<string, Map<string, string>> {
  const byFile = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    let fileTypes = byFile.get(entry.fileName);
    if (!fileTypes) {
      fileTypes = new Map();
      byFile.set(entry.fileName, fileTypes);
    }
    fileTypes.set(entry.className, entry.typeName);
  }
  return byFile;
}

function resolveRegisteredClassType(
  className: string,
  currentFile: string,
  classTypesByFile: Map<string, Map<string, string>>,
  importsByFile: Map<string, Map<string, ImportEntry>>,
): string | undefined {
  const localType = classTypesByFile.get(currentFile)?.get(className);
  if (localType) return localType;

  const imp = importsByFile.get(currentFile)?.get(className);
  if (!imp) return undefined;
  return classTypesByFile.get(imp.sourceFile)?.get(imp.importedName);
}

function generateClassSchema(
  classNode: N,
  docs: Map<number, ParsedJSDoc>,
  classTypesByFile: Map<string, Map<string, string>>,
  currentFile: string,
  aliasesByFile: Map<string, Map<string, N>>,
  enumsByFile: Map<string, Map<string, N>>,
  importsByFile: Map<string, Map<string, ImportEntry>>,
): TypeSchema {
  const fileDocs: FileDocs = { file: currentFile, at: docs };
  const ctx: SchemaCtx = {
    docs: fileDocs,
    currentFile,
    aliasesByFile,
    enumsByFile,
    importsByFile,
  };
  const className: string = classNode.id.name;
  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];
  const methods: Record<string, MethodSchema> = {};

  const buildMethodFromFn = (name: string, fn: N, startPos: number): MethodSchema | null => {
    if (name.startsWith('_')) return null;
    const doc = docs.get(startPos);
    if (doc?.annotations.hidden !== undefined) return null;

    const where = `${className}.${name}`;
    assertNoTags(doc, TYPE_FIELDS, where, currentFile);
    const isGenerator = !!fn.generator;
    if (doc?.post && isGenerator) {
      throw new SchemaParseError(
        `[schema/oxc] ${currentFile}: ${where} streams, so it declares no @post — its steps would apply post more than once`,
        currentFile,
      );
    }
    if (doc?.post && doc.kind === 'read') {
      throw new SchemaParseError(`[schema/oxc] ${currentFile}: ${where} is @read and writes nothing, so it declares no @post`, currentFile);
    }

    const args = actionArguments(fn.params ?? [], ctx, where, currentFile);
    const returnTa = fn.returnType?.typeAnnotation;
    let yieldsSchema: PropertySchema | undefined;
    if (isGenerator && returnTa?.type === 'TSTypeReference') {
      const genName = returnTa.typeName?.name;
      if (genName === 'AsyncGenerator' || genName === 'Generator') {
        const yieldType = (returnTa.typeArguments?.params ?? returnTa.typeParameters?.params)?.[0];
        if (yieldType) yieldsSchema = typeToSchema(yieldType, ctx);
      }
    }
    const ret = isGenerator ? {} : typeToSchema(returnTa, ctx);
    return {
      ...doc?.annotations,
      ...(doc?.kind ? { kind: doc.kind } : {}),
      ...(doc?.io ? { io: true } : {}),
      ...(doc?.pre ? { pre: doc.pre } : {}),
      ...(doc?.post ? { post: doc.post } : {}),
      ...(isGenerator ? { streaming: true } : {}),
      arguments: args,
      ...(isGenerator && yieldsSchema && Object.keys(yieldsSchema).length
        ? { yields: yieldsSchema }
        : {}),
      // C33: union returns are anyOf-shaped (no .type) — only emptiness disqualifies
      ...(!isGenerator && Object.keys(ret).length ? { return: ret } : {}),
    };
  };

  for (const member of classNode.body?.body ?? []) {
    if (member.type === 'PropertyDefinition' && member.key?.name && !member.static) {
      const name = member.key.name;
      if (docs.get(member.start)?.annotations.hidden !== undefined) continue;

      // Arrow-field method: `ship = (msg) => 42` — treated as method, not property.
      const initType = member.value?.type;
      if (initType === 'ArrowFunctionExpression' || initType === 'FunctionExpression') {
        const m = buildMethodFromFn(name, member.value, member.start);
        if (m) methods[name] = m;
        continue;
      }

      const ta = member.typeAnnotation?.typeAnnotation;
      const refType =
        ta?.type === 'TSTypeReference' && ta.typeName?.name
          ? resolveRegisteredClassType(ta.typeName.name, currentFile, classTypesByFile, importsByFile)
          : undefined;

      // Registered component class → path ref to that registered type.
      if (refType) {
        properties[name] = {
          type: 'string',
          format: 'path',
          refType,
        };
      } else {
        properties[name] = ta ? typeToSchema(ta, ctx) : typeFromInit(member.value);
      }

      Object.assign(properties[name], fieldAnnotations(fileDocs, member.start, `${className}.${name}`));

      // `default` and `required` are independent.
      // `default` is the initial value forms (and other writers) seed when the user
      // hasn't entered anything — it does NOT make the field optional. `required`
      // is the validation rule "this key must be present in the payload"; only
      // `?:` or `| undefined` in the TS type makes a field non-required.
      const def = evalInit(member.value, ctx);
      if (def !== undefined) properties[name].default = def;

      const hasUndef =
        ta?.type === 'TSUnionType' &&
        (ta.types as N[]).some((t: N) => t.type === 'TSUndefinedKeyword');
      if (!member.optional && !hasUndef) required.push(name);
    }

    if (member.type === 'MethodDefinition' && member.key?.name && member.kind === 'method') {
      const m = buildMethodFromFn(member.key.name, member.value, member.start);
      if (m) methods[member.key.name] = m;
    }
  }

  const doc = docs.get(classNode.start);
  assertNoTags(doc, ACTION_FIELDS, className, currentFile);
  return {
    type: 'object',
    ...doc?.annotations,
    ...(doc?.version !== undefined ? { version: doc.version } : {}),
    ...(doc?.actionsOnly ? { actionsOnly: true } : {}),
    ...(doc?.aliases ? { aliases: doc.aliases } : {}),
    properties,
    ...(required.length ? { required } : {}),
    ...(Object.keys(methods).length ? { methods } : {}),
  };
}

// ── File scanning ──

async function globSourceFiles(dirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    // A directory that cannot be read throws: skipping it would drop its schemas without a word.
    await (async function walkDir(d: string) {
      const entries = await fs.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist') await walkDir(full);
        else if (
          e.isFile() &&
          e.name.endsWith('.ts') &&
          !e.name.endsWith('.test.ts') &&
          !e.name.endsWith('.d.ts')
        )
          files.push(full);
      }
    })(path.resolve(dir));
  }
  return files;
}

// ── Main ──

export async function generateSchemas(dirs: string[]): Promise<void> {
  // A thrown run (parse error) may leave stale entries — reset per run.
  unresolvedRefs.clear();

  const t0 = performance.now();
  const files = await globSourceFiles(dirs);

  const allEntries: ComponentEntry[] = [];
  const allClasses = new Map<string, { node: N; docs: Map<number, ParsedJSDoc> }>();
  const allExternalActions = new Map<string, ExternalAction[]>();
  // Type aliases and enums are file-scoped: two modules may each define `type Entry = {...}`
  // or `enum Status` with different shapes. A global map would silently corrupt whichever
  // class was parsed second. Cross-file references are followed via the per-file import
  // map (ES imports), so `type X` in file A is resolvable from file B iff B imports X from A.
  const aliasesByFile = new Map<string, Map<string, N>>();
  const enumsByFile = new Map<string, Map<string, N>>();
  const importsByFile = new Map<string, Map<string, ImportEntry>>();

  for (const file of files) {
    const source = await fs.readFile(file, 'utf-8');
    const parsed = parseSync(path.basename(file), source);
    // C11: a file that fails to parse must break the run — silently skipping it
    // drops every schema it defines and downstream sees stale/missing types.
    if (parsed.errors.length) {
      const details = parsed.errors
        .slice(0, 3)
        .map((e) => e.message)
        .join('; ');
      throw new SchemaParseError(`[schema/oxc] parse failed for ${file}: ${details}`, file);
    }
    const { program: ast, comments } = parsed;
    const docs = buildJSDocMap(comments as Comment[], source, file);

    const fileAliases = findTypeAliases(ast as N);
    if (fileAliases.size) aliasesByFile.set(file, fileAliases);

    const fileEnums = findEnums(ast as N, file);
    if (fileEnums.size) enumsByFile.set(file, fileEnums);

    const fileImports = await findImports(ast as N, file);
    if (fileImports.size) importsByFile.set(file, fileImports);

    for (const e of findRegistrations(ast as N, file)) allEntries.push(e);

    for (const [name, node] of findClasses(ast as N))
      allClasses.set(name + '\0' + file, { node, docs });

    for (const [typeName, actions] of findExternalActions(ast as N, file)) {
      const existing = allExternalActions.get(typeName) ?? [];
      existing.push(...actions);
      allExternalActions.set(typeName, existing);
    }
  }

  const classTypesByFile = buildClassTypesByFile(allEntries);

  const generated = new Set<string>();
  let updated = 0;

  for (const entry of allEntries) {
    if (generated.has(entry.typeName)) continue;

    const classInfo = allClasses.get(entry.className + '\0' + entry.fileName);
    if (!classInfo) continue;

    const body = generateClassSchema(
      classInfo.node,
      classInfo.docs,
      classTypesByFile,
      entry.fileName,
      aliasesByFile,
      enumsByFile,
      importsByFile,
    );
    if (body.aliases?.includes(entry.typeName)) {
      throw new SchemaParseError(`[schema/oxc] ${entry.fileName}: ${entry.typeName} names itself in @alias`, entry.fileName);
    }
    generated.add(entry.typeName);

    // Merge external actions
    const external = allExternalActions.get(entry.typeName);
    if (external) {
      const methods: Record<string, MethodSchema> = body.methods ?? {};
      for (const act of external) {
        if (!methods[act.name]) {
          const { name, fileName: _, ...rest } = act;
          methods[name] = { arguments: [], ...rest };
        }
      }
      if (Object.keys(methods).length) body.methods = sortKeys(methods);
      allExternalActions.delete(entry.typeName);
    }

    const schema = {
      $id: entry.typeName,
      $schema: 'http://json-schema.org/draft-07/schema#',
      ...body,
    };

    // Write (skip if unchanged)
    const schemasDir = path.join(path.dirname(entry.fileName), 'schemas');
    const outFile = path.join(schemasDir, `${entry.typeName}.json`);
    const newContent = JSON.stringify(schema, null, 2) + '\n';
    const existing = await fs.readFile(outFile, 'utf-8').catch(() => '');
    if (existing === newContent) continue;
    await fs.mkdir(schemasDir, { recursive: true });
    await fs.writeFile(outFile, newContent);
    console.log(`  ${entry.typeName} → ${path.relative(process.cwd(), outFile)}`);
    updated++;
  }

  // Orphan external actions
  for (const [typeName, actions] of allExternalActions) {
    // 'default' schema is code-registered (server/actions.ts DEFAULT_SCHEMA, core-anz4.23);
    // emitting default.json here would re-register it via loadSchemasFromDir.
    if (typeName === 'default') continue;
    actions.sort((a, b) => a.fileName.localeCompare(b.fileName));
    const methods: Record<string, MethodSchema> = {};
    for (const act of actions) {
      const { name, fileName: _, ...rest } = act;
      methods[name] = { arguments: [], ...rest };
    }
    const schema = {
      $id: typeName,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object' as const,
      properties: {},
      methods: sortKeys(methods),
    };
    const schemasDir = path.join(path.dirname(actions[0].fileName), 'schemas');
    const outFile = path.join(schemasDir, `${typeName}.json`);
    const newContent = JSON.stringify(schema, null, 2) + '\n';
    const existing = await fs.readFile(outFile, 'utf-8').catch(() => '');
    if (existing === newContent) continue;
    await fs.mkdir(schemasDir, { recursive: true });
    await fs.writeFile(outFile, newContent);
    console.log(`  ${typeName} (actions only) → ${path.relative(process.cwd(), outFile)}`);
    updated++;
  }

  if (unresolvedRefs.size) {
    console.warn(
      `[schema] ${unresolvedRefs.size} unresolved type refs emitted {}: ${[...unresolvedRefs].sort().join(', ')}`,
    );
    unresolvedRefs.clear();
  }

  const elapsed = Math.round(performance.now() - t0);
  if (updated) console.log(`[schema/oxc] ${updated} updated (${elapsed}ms)`);
  else console.log(`[schema/oxc] all up to date (${elapsed}ms)`);
}

// CLI: tsx extract-schemas-oxc.ts dir1 dir2 ...
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  generateSchemas(process.argv.slice(2)).catch((e) => {
    // Non-zero exit so CI fails instead of silently shipping stale schemas
    console.error(e);
    process.exitCode = 1;
  });
}
