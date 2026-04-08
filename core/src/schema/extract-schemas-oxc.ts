// Schema extraction using OXC parser (Rust, ~20ms for 250 files)

import { parseSync } from 'oxc-parser';
import fs from 'node:fs/promises';
import * as path from 'node:path';

interface ComponentEntry { typeName: string; className: string; fileName: string }
interface ExternalAction { name: string; description?: string; arguments?: any[]; fileName: string }

type N = Record<string, any>;
type Comment = { type: string; value: string; start: number; end: number };

// ── JSDoc ──

function parseJSDoc(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.replace(/^\s*\*\s?/gm, '').trim().split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^@(\w+)(?:\s+(.*))?/);
    if (m) result[m[1]] = (m[2] ?? '').trim();
    else if (!result.title && !line.startsWith('@')) result.title = line;
  }
  return result;
}

function buildJSDocMap(comments: Comment[], source: string): Map<number, Record<string, string>> {
  const map = new Map<number, Record<string, string>>();
  for (const c of comments) {
    if (c.type !== 'Block' || !c.value.startsWith('*')) continue;
    let pos = c.end;
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    const doc = parseJSDoc(c.value);
    if (Object.keys(doc).length) map.set(pos, doc);
  }
  return map;
}

// ── Type → JSON Schema ──

interface SchemaCtx {
  jsDocMap?: Map<number, Record<string, string>>;
  typeAliases?: Map<string, N>;
  resolving?: Set<string>;
}

function typeToSchema(node: N | null | undefined, ctx: SchemaCtx = {}): any {
  if (!node) return {};

  switch (node.type) {
    case 'TSStringKeyword': return { type: 'string' };
    case 'TSNumberKeyword': return { type: 'number' };
    case 'TSBooleanKeyword': return { type: 'boolean' };
    case 'TSBigIntKeyword': return { type: 'integer' };

    case 'TSArrayType':
      return { type: 'array', items: typeToSchema(node.elementType, ctx) };

    case 'TSUnionType': {
      const types = node.types as N[];
      if (types.every(t => t.type === 'TSLiteralType' && typeof t.literal?.value === 'string'))
        return { type: 'string', enum: types.map(t => t.literal.value) };
      if (types.every(t => t.type === 'TSLiteralType' && typeof t.literal?.value === 'boolean'))
        return { type: 'boolean' };
      const nonUndef = types.filter(t => t.type !== 'TSUndefinedKeyword');
      if (nonUndef.length === 1) return typeToSchema(nonUndef[0], ctx);
      return { anyOf: nonUndef.map(t => typeToSchema(t, ctx)) };
    }

    case 'TSLiteralType': {
      const v = node.literal?.value;
      if (typeof v === 'string') return { type: 'string', enum: [v] };
      if (typeof v === 'number') return { type: 'number', enum: [v] };
      if (typeof v === 'boolean') return { type: 'boolean' };
      return {};
    }

    case 'TSTypeLiteral': {
      const properties: Record<string, any> = {};
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
      if (name === 'Promise' && tparams?.[0])
        return typeToSchema(tparams[0], ctx);
      if ((name === 'AsyncGenerator' || name === 'Generator') && tparams?.[0])
        return typeToSchema(tparams[0], ctx);

      // Resolve local type aliases (e.g. `type ThreadMessage = { ... }`)
      if (name && ctx.typeAliases?.has(name)) {
        const resolving = ctx.resolving ?? new Set();
        if (resolving.has(name)) return {};
        resolving.add(name);
        const result = typeToSchema(ctx.typeAliases.get(name), { ...ctx, resolving });
        resolving.delete(name);
        return result;
      }

      return {};
    }

    case 'TSTypeAnnotation': return typeToSchema(node.typeAnnotation, ctx);

    default: return {};
  }
}

function typeFromInit(value: N | null | undefined): any {
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

function evalInit(node: N | null | undefined): unknown {
  if (!node) return undefined;
  if (node.type === 'Literal') return typeof node.value === 'bigint' ? Number(node.value) : node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal')
    return -(node.argument.value as number);
  if (node.type === 'ArrayExpression') {
    const arr: unknown[] = [];
    for (const el of node.elements ?? []) {
      const v = evalInit(el);
      if (v === undefined) return undefined;
      arr.push(v);
    }
    return arr;
  }
  if (node.type === 'ObjectExpression') {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties ?? []) {
      if (prop.type !== 'Property' || !prop.key?.name) return undefined;
      const v = evalInit(prop.value);
      if (v === undefined) return undefined;
      obj[prop.key.name] = v;
    }
    return obj;
  }
  return undefined;
}

// ── AST walking ──

function walk(node: N, visitor: (n: N) => void) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(n => walk(n, visitor));
    else if (typeof v === 'object' && v !== null) walk(v, visitor);
  }
}

const REGISTER_FNS = new Set(['defineComponent', 'registerType']);

function findRegistrations(ast: N, fileName: string): ComponentEntry[] {
  const entries: ComponentEntry[] = [];
  walk(ast, node => {
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      REGISTER_FNS.has(node.callee.name)
    ) {
      const [typeArg, classArg] = node.arguments ?? [];
      if (typeArg?.type === 'Literal' && typeof typeArg.value === 'string' && classArg?.type === 'Identifier')
        entries.push({ typeName: typeArg.value, className: classArg.name, fileName });
    }
  });
  return entries;
}

function findClasses(ast: N): Map<string, N> {
  const classes = new Map<string, N>();
  walk(ast, node => {
    if (node.type === 'ClassDeclaration' && node.id?.name) classes.set(node.id.name, node);
  });
  return classes;
}

function findTypeAliases(ast: N): Map<string, N> {
  const aliases = new Map<string, N>();
  walk(ast, node => {
    if (node.type === 'TSTypeAliasDeclaration' && node.id?.name && node.typeAnnotation)
      aliases.set(node.id.name, node.typeAnnotation);
  });
  return aliases;
}

function findExternalActions(ast: N, fileName: string): Map<string, ExternalAction[]> {
  const byType = new Map<string, ExternalAction[]>();
  walk(ast, node => {
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'register' &&
      node.arguments?.length >= 3
    ) {
      const [typeArg, ctxArg, handlerArg] = node.arguments;
      if (
        typeArg?.type === 'Literal' && typeof typeArg.value === 'string' &&
        ctxArg?.type === 'Literal' && typeof ctxArg.value === 'string' &&
        ctxArg.value.startsWith('action:') && !ctxArg.value.includes(':', 7)
      ) {
        const actionName = ctxArg.value.slice(7);
        if (actionName.startsWith('_')) return;

        if (!byType.has(typeArg.value)) byType.set(typeArg.value, []);
        const list = byType.get(typeArg.value)!;
        if (list.some(a => a.name === actionName)) return;

        const action: ExternalAction = { name: actionName, fileName };

        // Extract handler param types (skip 1st ctx param)
        if (handlerArg?.type === 'ArrowFunctionExpression' || handlerArg?.type === 'FunctionExpression') {
          const params = handlerArg.params ?? [];
          const args: any[] = [];
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

function generateClassSchema(
  classNode: N,
  jsDocMap: Map<number, Record<string, string>>,
  classToType: Map<string, string>,
  typeAliases?: Map<string, N>,
): any {
  const ctx: SchemaCtx = { jsDocMap, typeAliases };
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const methods: Record<string, any> = {};

  for (const member of classNode.body?.body ?? []) {
    if (member.type === 'PropertyDefinition' && member.key?.name && !member.static) {
      const name = member.key.name;
      const doc = jsDocMap.get(member.start);
      if (doc?.hidden !== undefined) continue;
      const ta = member.typeAnnotation?.typeAnnotation;

      // Registered component class → refType
      if (ta?.type === 'TSTypeReference' && ta.typeName?.name && classToType.has(ta.typeName.name)) {
        properties[name] = { type: 'string', format: 'path', refType: classToType.get(ta.typeName.name) };
      } else {
        properties[name] = ta ? typeToSchema(ta, ctx) : typeFromInit(member.value);
      }

      Object.assign(properties[name], jsDocMap.get(member.start) ?? {});

      const def = evalInit(member.value);
      if (def !== undefined) properties[name].default = def;

      // `?` or `| undefined` in union → optional
      const hasUndef = ta?.type === 'TSUnionType' &&
        (ta.types as N[]).some((t: N) => t.type === 'TSUndefinedKeyword');
      if (!member.optional && !hasUndef) required.push(name);
    }

    if (member.type === 'MethodDefinition' && member.key?.name && member.kind === 'method') {
      const name = member.key.name;
      if (name.startsWith('_')) continue;
      if (jsDocMap.get(member.start)?.hidden !== undefined) continue;

      const fn = member.value;
      const params = fn.params ?? [];
      const args: any[] = [];
      for (const param of params) {
        const p = param.type === 'AssignmentPattern' ? param.left : param;
        args.push({ name: p.name ?? 'arg', ...typeToSchema(p.typeAnnotation?.typeAnnotation, ctx) });
      }

      const isGenerator = !!fn.generator;
      const returnTa = fn.returnType?.typeAnnotation;

      // For generators, unwrap AsyncGenerator<Y> → yields Y
      let yieldsSchema: any;
      if (isGenerator && returnTa?.type === 'TSTypeReference') {
        const genName = returnTa.typeName?.name;
        if (genName === 'AsyncGenerator' || genName === 'Generator') {
          const yieldType = (returnTa.typeArguments?.params ?? returnTa.typeParameters?.params)?.[0];
          if (yieldType) yieldsSchema = typeToSchema(yieldType, ctx);
        }
      }

      const ret = isGenerator ? {} : typeToSchema(returnTa, ctx);
      const methodDoc = { ...(jsDocMap.get(member.start) ?? {}) };

      if (typeof methodDoc.pre === 'string') (methodDoc as any).pre = methodDoc.pre.split(/\s+/).filter(Boolean);
      if (typeof methodDoc.post === 'string') (methodDoc as any).post = methodDoc.post.split(/\s+/).filter(Boolean);

      methods[name] = {
        ...methodDoc,
        ...(isGenerator ? { streaming: true } : {}),
        arguments: args,
        ...(isGenerator && yieldsSchema && Object.keys(yieldsSchema).length ? { yields: yieldsSchema } : {}),
        ...(!isGenerator && Object.keys(ret).length && ret.type !== undefined ? { return: ret } : {}),
      };
    }
  }

  return {
    type: 'object' as const,
    ...(jsDocMap.get(classNode.start) ?? {}),
    properties,
    ...(required.length ? { required } : {}),
    ...(Object.keys(methods).length ? { methods } : {}),
  };
}

// ── File scanning ──

async function globSourceFiles(dirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    await (async function walkDir(d: string) {
      let entries;
      try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist') await walkDir(full);
        else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) files.push(full);
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
  const allTypeAliases = new Map<string, N>();

  for (const file of files) {
    const source = await fs.readFile(file, 'utf-8');
    const { program: ast, comments } = parseSync(path.basename(file), source);
    const jsDocMap = buildJSDocMap(comments as Comment[], source);

    for (const [name, node] of findTypeAliases(ast as N))
      allTypeAliases.set(name, node);

    for (const e of findRegistrations(ast as N, file)) allEntries.push(e);

    for (const [name, node] of findClasses(ast as N))
      allClasses.set(name + '\0' + file, { node, jsDocMap });

    for (const [typeName, actions] of findExternalActions(ast as N, file)) {
      const existing = allExternalActions.get(typeName) ?? [];
      existing.push(...actions);
      allExternalActions.set(typeName, existing);
    }
  }

  const classToType = new Map<string, string>();
  for (const e of allEntries) classToType.set(e.className, e.typeName);

  const generated = new Set<string>();
  let updated = 0;

  for (const entry of allEntries) {
    if (generated.has(entry.typeName)) continue;

    const classInfo = allClasses.get(entry.className + '\0' + entry.fileName);
    if (!classInfo) continue;

    const schema = generateClassSchema(classInfo.node, classInfo.jsDocMap, classToType, allTypeAliases);
    schema.$id = entry.typeName;
    schema.$schema = 'http://json-schema.org/draft-07/schema#';
    generated.add(entry.typeName);

    // Merge external actions
    const external = allExternalActions.get(entry.typeName);
    if (external) {
      const methods: Record<string, any> = schema.methods ?? {};
      for (const act of external) {
        if (!methods[act.name]) {
          const { name, fileName: _, ...rest } = act;
          methods[name] = { arguments: [], ...rest };
        }
      }
      if (Object.keys(methods).length) schema.methods = methods;
      allExternalActions.delete(entry.typeName);
    }

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
    const methods: Record<string, any> = {};
    for (const act of actions) {
      const { name, fileName: _, ...rest } = act;
      methods[name] = { arguments: [], ...rest };
    }
    const schema = {
      $id: typeName, $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object' as const, properties: {}, methods,
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
