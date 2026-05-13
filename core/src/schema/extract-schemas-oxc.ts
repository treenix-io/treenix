// Schema extraction using OXC parser (Rust, ~20ms for 250 files)

import { parseSync } from 'oxc-parser';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MethodArgSchema, MethodSchema, PropertySchema, TypeSchema } from '#schema/types';

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

// Whitelist of allowed JSDoc tags. Unknown tags throw to catch typos.
// Module-specific tags can use the `@x-foo` escape (Phase 1.2).
const KNOWN_TAGS = new Set([
  // identity / docs
  'title', 'description', 'deprecated', 'internal', 'example', 'see',
  // schema annotations
  'format', 'refType', 'hidden', 'opaque', 'dangerous',
  // method kind (Phase 1) — `@mutation`/`@query` are graceful-migration aliases
  'read', 'write', 'io', 'mutation', 'query',
  // dataflow contract
  'pre', 'post',
  // standard JSDoc — silently ignored
  'param', 'returns', 'throws', 'default',
]);


// Parse JSDoc comment body into a tag map.
// Line-oriented:
//   - If a line's first non-whitespace char is NOT `@` → prose. Embedded
//     `@word` (e.g. `(see @treenx/core)` or `test @treenx`) is text, not a tag.
//     First prose line becomes implicit title; rest joins description.
//   - If a line starts with `@` → tag-line. Multiple tags allowed:
//     `@title Foo @format bar`, or `@read @io` (combined kind+modifier).
// Tag name: letter-led, allows digits/underscore/hyphen for `@x-foo` escape.
export type ParsedJSDoc = Record<string, string> & {
  kind?: 'read' | 'write';
  io?: boolean;
};

export function parseJSDoc(raw: string): ParsedJSDoc {
  const result: Record<string, any> = {};
  if (!raw) return result;
  const plainDescriptionParts: string[] = [];
  let hasExplicitDescription = false;

  const lines = raw
    .replace(/^\s*\*\s?/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Prose-line: first non-WS char is not `@`. Embedded `@word` is text.
    if (!line.startsWith('@')) {
      if (!result.title) result.title = line;
      else plainDescriptionParts.push(line);
      continue;
    }

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
      if (name === 'description') hasExplicitDescription = true;
      result[name] = value;
    }
  }

  if (!hasExplicitDescription && plainDescriptionParts.length) {
    result.description = plainDescriptionParts.join(' ');
  }
  if (result.description === result.title) {
    delete result.description;
  }

  for (const name of Object.keys(result)) {
    if (!KNOWN_TAGS.has(name) && !name.startsWith('x-')) {
      throw new JSDocError(`Unknown JSDoc tag: @${name}`);
    }
  }

  // Kind tags: @read/@write canonical; @query/@mutation graceful-migration aliases.
  const kindTags: { tag: string; value: 'read' | 'write' }[] = [];
  if ('read' in result) kindTags.push({ tag: 'read', value: 'read' });
  if ('query' in result) kindTags.push({ tag: 'query', value: 'read' });
  if ('write' in result) kindTags.push({ tag: 'write', value: 'write' });
  if ('mutation' in result) kindTags.push({ tag: 'mutation', value: 'write' });

  if (kindTags.length) {
    const distinct = new Set(kindTags.map((k) => k.value));
    if (distinct.size > 1) {
      throw new JSDocError(
        `Conflicting kind tags: ${kindTags.map((k) => '@' + k.tag).join(' ')}`,
      );
    }
    for (const k of kindTags) delete result[k.tag];
    result.kind = kindTags[0].value;
  }

  if ('io' in result) {
    result.io = true;
  }

  return result as ParsedJSDoc;
}

function buildJSDocMap(comments: Comment[], source: string): Map<number, Record<string, string>> {
  const map = new Map<number, Record<string, string>>();
  for (const c of comments) {
    if (c.type !== 'Block' || !c.value.startsWith('*')) continue;
    let pos = c.end;
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    const doc = parseJSDoc(c.value);
    if (!Object.keys(doc).length) continue;
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

interface SchemaCtx {
  jsDocMap?: Map<number, Record<string, string>>;
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
      if (types.every((t) => t.type === 'TSLiteralType' && typeof t.literal?.value === 'string'))
        return { type: 'string', enum: types.map((t) => t.literal.value) };
      if (types.every((t) => t.type === 'TSLiteralType' && typeof t.literal?.value === 'number'))
        return { type: 'number', enum: types.map((t) => t.literal.value) };
      if (types.every((t) => t.type === 'TSLiteralType' && typeof t.literal?.value === 'boolean'))
        return { type: 'boolean' };
      const nonUndef = types.filter((t) => t.type !== 'TSUndefinedKeyword');
      if (nonUndef.length === 1) return typeToSchema(nonUndef[0], ctx);
      return { anyOf: nonUndef.map((t) => typeToSchema(t, ctx)) };
    }

    case 'TSLiteralType': {
      const v = node.literal?.value;
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
          if (ctx.jsDocMap) Object.assign(properties[m.key.name], ctx.jsDocMap.get(m.start) ?? {});
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

      return {};
    }

    case 'TSTypeAnnotation':
      return typeToSchema(node.typeAnnotation, ctx);

    default:
      return {};
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
          const params = handlerArg.params ?? [];
          const args: MethodArgSchema[] = [];
          for (let i = 1; i < params.length; i++) {
            const p = params[i];
            args.push({ name: p.name ?? 'arg', ...typeToSchema(p.typeAnnotation?.typeAnnotation) });
          }
          if (args.length) action.arguments = args;
        }

        list.push(action);
      }
    }
  });
  return byType;
}

// ── Schema generation ──

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
  jsDocMap: Map<number, Record<string, string>>,
  classTypesByFile: Map<string, Map<string, string>>,
  currentFile: string,
  aliasesByFile: Map<string, Map<string, N>>,
  enumsByFile: Map<string, Map<string, N>>,
  importsByFile: Map<string, Map<string, ImportEntry>>,
): TypeSchema & { $id?: string; $schema?: string } {
  const ctx: SchemaCtx = {
    jsDocMap,
    currentFile,
    aliasesByFile,
    enumsByFile,
    importsByFile,
  };
  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];
  const methods: Record<string, MethodSchema> = {};

  const buildMethodFromFn = (name: string, fn: N, startPos: number): MethodSchema | null => {
    if (name.startsWith('_')) return null;
    if (jsDocMap.get(startPos)?.hidden !== undefined) return null;
    const params = fn.params ?? [];
    const args: MethodArgSchema[] = [];
    for (const param of params) {
      const p = param.type === 'AssignmentPattern' ? param.left : param;
      args.push({
        name: p.name ?? 'arg',
        ...typeToSchema(p.typeAnnotation?.typeAnnotation, ctx),
      });
    }
    const isGenerator = !!fn.generator;
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
    const methodDoc: Record<string, unknown> = { ...(jsDocMap.get(startPos) ?? {}) };
    if (typeof methodDoc.pre === 'string')
      methodDoc.pre = (methodDoc.pre as string).split(/\s+/).filter(Boolean);
    if (typeof methodDoc.post === 'string')
      methodDoc.post = (methodDoc.post as string).split(/\s+/).filter(Boolean);
    return {
      ...methodDoc,
      ...(isGenerator ? { streaming: true } : {}),
      arguments: args,
      ...(isGenerator && yieldsSchema && Object.keys(yieldsSchema).length
        ? { yields: yieldsSchema }
        : {}),
      ...(!isGenerator && Object.keys(ret).length && ret.type !== undefined ? { return: ret } : {}),
    } as MethodSchema;
  };

  for (const member of classNode.body?.body ?? []) {
    if (member.type === 'PropertyDefinition' && member.key?.name && !member.static) {
      const name = member.key.name;
      const doc = jsDocMap.get(member.start);
      if (doc?.hidden !== undefined) continue;

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

      Object.assign(properties[name], jsDocMap.get(member.start) ?? {});

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
      const name = member.key.name;
      if (name.startsWith('_')) continue;
      if (jsDocMap.get(member.start)?.hidden !== undefined) continue;

      const fn = member.value;
      const params = fn.params ?? [];
      const args: MethodArgSchema[] = [];
      for (const param of params) {
        const p = param.type === 'AssignmentPattern' ? param.left : param;
        args.push({
          name: p.name ?? 'arg',
          ...typeToSchema(p.typeAnnotation?.typeAnnotation, ctx),
        });
      }

      const isGenerator = !!fn.generator;
      const returnTa = fn.returnType?.typeAnnotation;

      // For generators, unwrap AsyncGenerator<Y> → yields Y
      let yieldsSchema: PropertySchema | undefined;
      if (isGenerator && returnTa?.type === 'TSTypeReference') {
        const genName = returnTa.typeName?.name;
        if (genName === 'AsyncGenerator' || genName === 'Generator') {
          const yieldType = (returnTa.typeArguments?.params ??
            returnTa.typeParameters?.params)?.[0];
          if (yieldType) yieldsSchema = typeToSchema(yieldType, ctx);
        }
      }

      const ret = isGenerator ? {} : typeToSchema(returnTa, ctx);
      const methodDoc: Record<string, unknown> = { ...(jsDocMap.get(member.start) ?? {}) };

      if (typeof methodDoc.pre === 'string')
        methodDoc.pre = (methodDoc.pre as string).split(/\s+/).filter(Boolean);
      if (typeof methodDoc.post === 'string')
        methodDoc.post = (methodDoc.post as string).split(/\s+/).filter(Boolean);

      methods[name] = {
        ...methodDoc,
        ...(isGenerator ? { streaming: true } : {}),
        arguments: args,
        ...(isGenerator && yieldsSchema && Object.keys(yieldsSchema).length
          ? { yields: yieldsSchema }
          : {}),
        ...(!isGenerator && Object.keys(ret).length && ret.type !== undefined
          ? { return: ret }
          : {}),
      } as MethodSchema;
    }
  }

  return {
    type: 'object' as const,
    ...(jsDocMap.get(classNode.start) ?? {}),
    properties,
    ...(required.length ? { required } : {}),
    ...(Object.keys(methods).length ? { methods } : {}),
  } as TypeSchema;
}

// ── File scanning ──

async function globSourceFiles(dirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    await (async function walkDir(d: string) {
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
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
  const t0 = performance.now();
  const files = await globSourceFiles(dirs);

  const allEntries: ComponentEntry[] = [];
  const allClasses = new Map<string, { node: N; jsDocMap: Map<number, Record<string, string>> }>();
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
    const { program: ast, comments } = parseSync(path.basename(file), source);
    const jsDocMap = buildJSDocMap(comments as Comment[], source);

    const fileAliases = findTypeAliases(ast as N);
    if (fileAliases.size) aliasesByFile.set(file, fileAliases);

    const fileEnums = findEnums(ast as N, file);
    if (fileEnums.size) enumsByFile.set(file, fileEnums);

    const fileImports = await findImports(ast as N, file);
    if (fileImports.size) importsByFile.set(file, fileImports);

    for (const e of findRegistrations(ast as N, file)) allEntries.push(e);

    for (const [name, node] of findClasses(ast as N))
      allClasses.set(name + '\0' + file, { node, jsDocMap });

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
      classInfo.jsDocMap,
      classTypesByFile,
      entry.fileName,
      aliasesByFile,
      enumsByFile,
      importsByFile,
    );
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

  const elapsed = Math.round(performance.now() - t0);
  if (updated) console.log(`[schema/oxc] ${updated} updated (${elapsed}ms)`);
  else console.log(`[schema/oxc] all up to date (${elapsed}ms)`);
}

// CLI: tsx extract-schemas-oxc.ts dir1 dir2 ...
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  generateSchemas(process.argv.slice(2)).catch(console.error);
}
