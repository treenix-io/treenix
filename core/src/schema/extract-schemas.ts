#!/usr/bin/env tsx
// Schema extractor for defineComponent("type", Class)
// Own JSON Schema generator — no typescript-json-schema dependency
// Reads JSDoc: class comment → schema title, @title/@format/@description on properties

import fs from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';

interface ComponentEntry {
  typeName: string;
  className: string;
  fileName: string;
}

function createProgram(tsconfigPath: string, extraFiles: string[] = []): ts.Program {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error)
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  return ts.createProgram([...parsed.fileNames, ...extraFiles], parsed.options);
}

const REGISTER_FNS = new Set(['defineComponent', 'registerType']);

function findDefineComponents(program: ts.Program): ComponentEntry[] {
  const entries: ComponentEntry[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('.test.')) continue;
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        REGISTER_FNS.has(node.expression.text)
      ) {
        const [typeArg, classArg] = node.arguments;
        if (typeArg && ts.isStringLiteral(typeArg) && classArg && ts.isIdentifier(classArg))
          entries.push({ typeName: typeArg.text, className: classArg.text, fileName: sf.fileName });
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sf, visit);
  }
  return entries;
}

type ExternalAction = { name: string; description?: string; arguments?: any[]; fileName: string };

// Find server-side register(type, 'action:name', handler) calls — actions without class methods.
// These are invisible to clients unless declared in the schema.
// Extracts description from 4th meta arg or JSDoc, and handler param types for arguments.
function findExternalActions(program: ts.Program): Map<string, ExternalAction[]> {
  const checker = program.getTypeChecker();
  const byType = new Map<string, ExternalAction[]>();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('.test.')) continue;

    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'register' &&
        node.arguments.length >= 3
      ) {
        const [typeArg, ctxArg, handlerArg, metaArg] = node.arguments;
        if (
          typeArg && ts.isStringLiteral(typeArg) &&
          ctxArg && ts.isStringLiteral(ctxArg) &&
          ctxArg.text.startsWith('action:') &&
          !ctxArg.text.includes(':', 7)
        ) {
          const typeName = typeArg.text;
          const actionName = ctxArg.text.slice(7);
          if (!actionName.startsWith('_')) {
            const action: ExternalAction = { name: actionName, fileName: sf.fileName };

            // 1. Description from meta arg: register(type, ctx, handler, { description: '...' })
            if (metaArg && ts.isObjectLiteralExpression(metaArg)) {
              for (const prop of metaArg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === 'description' &&
                  ts.isStringLiteral(prop.initializer)
                ) {
                  action.description = prop.initializer.text;
                }
              }
            }

            // 2. Fallback: JSDoc on the enclosing statement
            if (!action.description) {
              const stmt = node.parent && ts.isExpressionStatement(node.parent) ? node.parent : node;
              const doc = collectJSDoc(stmt);
              if (doc.description) action.description = doc.description;
              else if (doc.title) action.description = doc.title;
            }

            // 3. Handler param types → arguments (skip 1st ctx param)
            if (handlerArg) {
              const args = extractHandlerArgs(checker, handlerArg);
              if (args.length) action.arguments = args;
            }

            if (!byType.has(typeName)) byType.set(typeName, []);
            const list = byType.get(typeName)!;
            if (!list.some((a) => a.name === actionName)) list.push(action);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sf, visit);
  }
  return byType;
}

// Extract typed arguments from handler function (2nd+ params, skipping ctx)
function extractHandlerArgs(checker: ts.TypeChecker, handlerNode: ts.Node): any[] {
  // Resolve to the actual function: inline arrow/function or identifier reference
  let fn: ts.SignatureDeclaration | undefined;

  if (ts.isFunctionExpression(handlerNode) || ts.isArrowFunction(handlerNode)) {
    fn = handlerNode;
  } else if (ts.isIdentifier(handlerNode)) {
    const sym = checker.getSymbolAtLocation(handlerNode);
    const decl = sym?.valueDeclaration;
    if (decl && (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl))) {
      fn = decl;
    }
  }
  if (!fn) return [];

  // Skip first param (ctx: ActionCtx), extract rest
  const params = fn.parameters.slice(1);
  const args: any[] = [];
  for (const param of params) {
    const paramType = checker.getTypeAtLocation(param);
    const schema = typeToJsonSchema(checker, paramType);
    args.push({ name: (param.name as ts.Identifier).text, ...schema });
  }
  return args;
}

/** Check if a type's declaration has @opaque JSDoc tag */
function isOpaqueType(checker: ts.TypeChecker, type: ts.Type): boolean {
  // Try aliasSymbol first (preserved for direct type references)
  const decl = type.aliasSymbol?.declarations?.[0] ?? type.symbol?.declarations?.[0];
  if (decl && ts.getJSDocTags(decl).some((tag) => tag.tagName.text === 'opaque')) return true;
  return false;
}

/** Check if a parameter's type annotation points to an @opaque type (uses AST node) */
function isOpaqueParam(checker: ts.TypeChecker, param: ts.ParameterDeclaration): boolean {
  if (!param.type || !ts.isTypeReferenceNode(param.type)) return false;
  let sym = checker.getSymbolAtLocation(param.type.typeName);
  if (!sym) return false;
  // Resolve through imports to original declaration
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const typeDecl = sym?.declarations?.[0];
  if (!typeDecl) return false;
  return ts.getJSDocTags(typeDecl).some((tag) => tag.tagName.text === 'opaque');
}

function typeToJsonSchema(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): any {
  if (seen.has(type)) return {};
  if (isOpaqueType(checker, type)) return {};
  if (type.flags & ts.TypeFlags.String) return { type: 'string' };
  if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
  if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (type.flags & ts.TypeFlags.BigInt) return { type: 'integer' };
  if (type.isUnion()) {
    const literals = type.types.filter((t) => t.isStringLiteral());
    if (literals.length === type.types.length)
      return { type: 'string', enum: literals.map((t) => (t as ts.StringLiteralType).value) };
    if (type.types.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) return { type: 'boolean' };
    return { anyOf: type.types.map((t) => typeToJsonSchema(checker, t, seen)) };
  }
  if (type.flags & ts.TypeFlags.Object) {
    seen.add(type);
    if (checker.isArrayType(type)) {
      const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
      return { type: 'array', items: typeArgs[0] ? typeToJsonSchema(checker, typeArgs[0], seen) : {} };
    }
    const props = type.getProperties();
    if (props.length > 0) {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const prop of props) {
        const propType = checker.getTypeOfSymbol(prop);
        properties[prop.name] = typeToJsonSchema(checker, propType, seen);
        const decl = prop.valueDeclaration;
        if (decl) Object.assign(properties[prop.name], collectJSDoc(decl));
        if (decl && ts.isPropertySignature(decl) && !decl.questionToken) required.push(prop.name);
        if (decl && ts.isPropertyDeclaration(decl) && !decl.questionToken) required.push(prop.name);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
  }
  return {};
}

// Extract JSDoc tag text from a node
function getJSDocTagValues(node: ts.Node, ...tagNames: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const tags = ts.getJSDocTags(node);
  for (const tagName of tagNames) {
    let value;
    // full description comment
    if (tagName === 'title') {
      value = (node as any)?.jsDoc?.[0]?.comment;
    }
    if (!value) {
      for (const tag of tags) {
        if (tag.tagName.text === tagName) {
          value = tag.comment;
          break;
        }
      }
    }
    if (value) {
      if (typeof value === 'string') result[tagName] = value;
      if (Array.isArray(value)) result[tagName] = value.map((c) => c.text).join('');
    }
  }
  return result;
}

export function collectJSDoc(node: ts.Node) {
  const result = getJSDocTagValues(node, 'title', 'format', 'description', 'refType', 'pre', 'post');

  // Inline JSDoc fallback: `{ /** comment */ prop: T }` — TS doesn't attach jsDoc node,
  // but the comment text is in the trivia between getFullStart() and getStart()
  if (!result.title && !result.description) {
    const sf = node.getSourceFile();
    if (sf) {
      const trivia = sf.text.slice(node.getFullStart(), node.getStart(sf));
      const m = trivia.match(/\/\*\*\s*(.*?)\s*\*\//);
      if (m?.[1]) {
        // Check for @tag patterns — extract them, use remainder as title
        const tagText = m[1];
        const tagMatch = tagText.match(/@(\w+)\s+(.*)/);
        if (tagMatch) result[tagMatch[1]] = tagMatch[2].trim();
        else result.title = tagText;
      }
    }
  }

  return result;
}

// Strip `undefined` from union types (T | undefined → T)
function unwrapOptional(type: ts.Type): ts.Type {
  if (type.isUnion()) {
    const nonUndef = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
    if (nonUndef.length === 1) return nonUndef[0];
  }
  return type;
}

function generateClassSchema(program: ts.Program, entry: ComponentEntry, classToType: Map<string, string>) {
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entry.fileName);
  if (!sf) return null;

  let classNode: ts.ClassDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name?.text === entry.className) classNode = node;
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  if (!classNode) return null;

  const properties: Record<string, any> = {};
  const required: string[] = [];
  const methods: Record<string, any> = {};

  for (const member of classNode.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      member.name &&
      ts.isIdentifier(member.name) &&
      !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
    ) {
      const name = member.name.text;
      const symbol = checker.getSymbolAtLocation(member.name);
      if (!symbol) continue;
      const type = checker.getTypeOfSymbol(symbol);

      // Check if property type is a registered component class → emit refType
      const resolved = unwrapOptional(type);
      const typeSym = resolved.getSymbol();
      const typeDecl = typeSym?.declarations?.[0];
      const refTypeName = typeDecl && ts.isClassDeclaration(typeDecl) && typeDecl.name
        ? classToType.get(typeDecl.name.text) : undefined;

      if (refTypeName) {
        properties[name] = { type: 'string', format: 'path', refType: refTypeName };
      } else {
        properties[name] = typeToJsonSchema(checker, type);
      }
      Object.assign(properties[name], collectJSDoc(member));
      // Default value
      if (member.initializer) {
        if (ts.isStringLiteral(member.initializer))
          properties[name].default = member.initializer.text;
        else if (ts.isNumericLiteral(member.initializer))
          properties[name].default = Number(member.initializer.text);
        else if (member.initializer.kind === ts.SyntaxKind.TrueKeyword)
          properties[name].default = true;
        else if (member.initializer.kind === ts.SyntaxKind.FalseKeyword)
          properties[name].default = false;
      }
      if (!member.questionToken) required.push(name);
    }

    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const name = member.name.text;
      if (name.startsWith('_')) continue; // _ = internal, hidden from schema
      const sig = checker.getSignatureFromDeclaration(member);
      if (!sig) continue;

      const args: any[] = [];
      for (let i = 0; i < sig.parameters.length; i++) {
        const astParam = member.parameters[i];
        if (astParam && isOpaqueParam(checker, astParam)) continue;
        const paramType = checker.getTypeOfSymbol(sig.parameters[i]);
        args.push({ name: sig.parameters[i].name, ...typeToJsonSchema(checker, paramType) });
      }

      const isGenerator = !!member.asteriskToken;
      let returnType = checker.getReturnTypeOfSignature(sig);

      // For generators, unwrap AsyncGenerator<Y, R, N> → use Y as yields type
      let yieldsSchema: any = undefined;
      if (isGenerator) {
        const genName = returnType.symbol?.name;
        if (genName === 'AsyncGenerator' || genName === 'Generator') {
          const typeArgs = checker.getTypeArguments(returnType as ts.TypeReference);
          if (typeArgs[0]) yieldsSchema = typeToJsonSchema(checker, typeArgs[0]);
        }
      } else if (returnType.symbol?.name === 'Promise') {
        const typeArgs = checker.getTypeArguments(returnType as ts.TypeReference);
        if (typeArgs[0]) returnType = typeArgs[0];
      }

      const ret = isGenerator ? {} : typeToJsonSchema(checker, returnType);
      const methodDoc = collectJSDoc(member);
      // Parse @pre/@post as space-separated field name arrays
      if (typeof methodDoc.pre === 'string') methodDoc.pre = methodDoc.pre.split(/\s+/).filter(Boolean) as any;
      if (typeof methodDoc.post === 'string') methodDoc.post = methodDoc.post.split(/\s+/).filter(Boolean) as any;
      methods[name] = {
        ...methodDoc,
        ...(isGenerator ? { streaming: true } : {}),
        arguments: args,
        ...(isGenerator && yieldsSchema && Object.keys(yieldsSchema).length ? { yields: yieldsSchema } : {}),
        ...(!isGenerator && Object.keys(ret).length && !(returnType.flags & ts.TypeFlags.Void)
          ? { return: ret }
          : {}),
      };
    }
  }

  return {
    $id: entry.typeName,
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object' as const,
    ...collectJSDoc(classNode),
    properties,
    ...(required.length ? { required } : {}),
    ...(Object.keys(methods).length ? { methods } : {}),
  };
}

export async function exec(tsconfigPath = 'tsconfig.json', extraDirs: string[] = []): Promise<void> {
  const extraFiles = await globSourceFiles(extraDirs);
  const program = createProgram(tsconfigPath, extraFiles);
  const entries = findDefineComponents(program);
  const externalActions = findExternalActions(program);
  console.log(`Found ${entries.length} component(s), ${externalActions.size} type(s) with external actions`);

  // Build className → typeName map for refType detection
  const classToType = new Map<string, string>();
  for (const e of entries) classToType.set(e.className, e.typeName);

  const generated = new Set<string>();

  for (const entry of entries) {
    if (generated.has(entry.typeName)) continue; // override registration — schema already extracted from base class

    const schema = generateClassSchema(program, entry, classToType);
    if (!schema) {
      console.warn(`  SKIP ${entry.className}`);
      continue;
    }
    generated.add(entry.typeName);

    // Merge server-side register(type, 'action:name') into schema.methods
    const external = externalActions.get(entry.typeName);
    if (external) {
      const methods: Record<string, any> = schema.methods ?? {};
      for (const act of external) {
        if (!methods[act.name]) {
          const { name, fileName: _, ...rest } = act;
          methods[name] = { arguments: [], ...rest };
        }
      }
      if (Object.keys(methods).length) schema.methods = methods;
      externalActions.delete(entry.typeName);
    }

    // Write schema next to source file in schemas/ subdir
    const schemasDir = path.join(path.dirname(entry.fileName), 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });
    const outFile = path.join(schemasDir, `${entry.typeName}.json`);
    await fs.writeFile(outFile, JSON.stringify(schema, null, 2) + '\n');
    console.log(`  ${entry.typeName} → ${path.relative(process.cwd(), outFile)}`);
  }

  // Types with external actions but no registerType class — generate action-only schemas
  for (const [typeName, actions] of externalActions) {
    const methods: Record<string, any> = {};
    for (const act of actions) {
      const { name, fileName: _, ...rest } = act;
      methods[name] = { arguments: [], ...rest };
    }
    const schema = {
      $id: typeName,
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object' as const,
      properties: {},
      methods,
    };
    // Write next to source of first action
    const schemasDir = path.join(path.dirname(actions[0].fileName), 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });
    const outFile = path.join(schemasDir, `${typeName}.json`);
    await fs.writeFile(outFile, JSON.stringify(schema, null, 2) + '\n');
    console.log(`  ${typeName} (actions only) → ${path.relative(process.cwd(), outFile)}`);
  }
}

async function globSourceFiles(dirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    await (async function walk(d: string) {
      const entries = await fs.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && e.name !== 'node_modules') await walk(full);
        else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) files.push(full);
      }
    })(abs);
  }
  return files;
}

// CLI: tsx extract-schemas.ts [extraDir...]
const extraDirs = process.argv.slice(2);
exec(undefined, extraDirs).catch(console.error);
