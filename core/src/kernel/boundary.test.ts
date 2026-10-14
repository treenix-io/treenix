import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const kernelDir = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(kernelDir);

// Direct imports only: a kernel file may import the kernel, Layer 0, pure helpers and errors; what those
// areas import in turn is not checked here. Packages other than node built-ins are refused until one is
// admitted here with a reason. errors is the KernelError class alone, built on the kernel's own ErrorCode.
const ALLOWED = ['kernel', 'core', 'util', 'comp', 'schema/types', 'errors'];

// Action drafts use the same mutation engine as authored component methods.
const PACKAGES: readonly string[] = ['immer'];

// These composition owners bind existing native declarations, wire clients and sandbox runtimes.
const OWNER_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'instance.ts': ['mod/loader'],
  'auth-pairing.ts': ['security/agent'],
  'manifest.ts': ['mod/native-prefab'],
  'periodic-service.ts': ['client/lane-cache'],
  'type-description.ts': ['system/native-actions'],
  'authority/owner.ts': ['client/twp'],
  'source-worker-bootstrap.ts': ['tsx/esm/api'],
  'source-worker.ts': ['quickjs-emscripten'],
};

type PackageImports = { readonly [key: string]: { readonly development: string } };
const packageImports: PackageImports = JSON.parse(
  readFileSync(join(srcDir, '../package.json'), 'utf8'),
).imports;

function specifiers(source: string): string[] {
  const result: string[] = [];
  function visit(node: ts.Node): void {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          ? node.moduleReference.expression
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) result.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return result;
}

function packageTarget(spec: string): string | undefined {
  const exact = packageImports[spec];
  if (exact) return exact.development;

  for (const [key, target] of Object.entries(packageImports)) {
    const [prefix, suffix] = key.split('*');
    if (suffix !== undefined && spec.startsWith(prefix) && spec.endsWith(suffix))
      return target.development.replace(
        '*',
        spec.slice(prefix.length, spec.length - suffix.length),
      );
  }

  return undefined;
}

function allowed(file: string, spec: string): boolean {
  if (spec.startsWith('node:') || PACKAGES.includes(spec)) return true;
  // The boundary check parses source with the development dependency; runtime kernel files cannot import it.
  if (file === fileURLToPath(import.meta.url) && spec === 'typescript') return true;

  const owned = OWNER_IMPORTS[relative(kernelDir, file)];
  if (owned?.includes(spec)) return true;
  const mapped = spec.startsWith('#') ? packageTarget(spec) : undefined;
  const local = spec.startsWith('.')
    ? resolve(dirname(file), spec)
    : mapped === undefined
      ? null
      : resolve(srcDir, '..', mapped);
  if (local === null) return false;

  const target = relative(srcDir, local).replace(/\.tsx?$/, '');
  // Instance owns native module discovery; the remaining kernel stays independent of the loader.
  if (owned?.includes(target)) return true;
  return ALLOWED.some((area) => target === area || target.startsWith(`${area}/`));
}

function kernelFiles(): string[] {
  return readdirSync(kernelDir, { recursive: true, encoding: 'utf8' })
    .filter(
      (name) =>
        /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.typecheck\.ts$/.test(name),
    )
    .map((name) => join(kernelDir, name));
}

describe('kernel import boundary', () => {
  it('production kernel files import only the kernel, Layer 0, util, comp, schema types, errors and admitted packages', () => {
    const imports = kernelFiles().flatMap((file) =>
      specifiers(readFileSync(file, 'utf8')).map((spec) => ({ file, spec })),
    );

    assert.ok(imports.length > 0);
    assert.deepEqual(
      imports
        .filter(({ file, spec }) => !allowed(file, spec))
        .map(({ file, spec }) => `${relative(srcDir, file)}: ${spec}`),
      [],
    );
  });

  it('finds every import form, multi-line and type-only included', () => {
    // Quotes go through q so that scanning this file does not read the fixture as its imports.
    const q = "'";
    const source = [
      `import type { A } from ${q}#tree${q}`,
      `import {`,
      `  b,`,
      `} from ${q}#server/actions${q}`,
      `export * from ${q}./types${q}`,
      `import ${q}#sub${q}`,
      `const m = await import(${q}#mount${q})`,
      `const n = Array.from(${q}xy${q})`,
    ].join('\n');

    assert.deepEqual(specifiers(source), ['#tree', '#server/actions', './types', '#sub', '#mount']);
  });

  it('admits the allowed areas, node built-ins and admitted packages', () => {
    const file = join(kernelDir, 'contract', 'x.ts');
    for (const spec of [
      '../types',
      '#kernel/types',
      '#core',
      '#core/path',
      '#util/ulid',
      '#comp',
      '#comp/needs',
      '#schema/types',
      '#errors',
      'node:fs',
      'immer',
    ])
      assert.equal(allowed(file, spec), true, spec);
  });

  it('does not read quoted field names as import declarations', () => {
    const q = "'";
    assert.deepEqual(
      specifiers(`type Side = ${q}from${q} | ${q}to${q}; const value = ${q}import${q}`),
      [],
    );
    assert.deepEqual(
      specifiers(`put(${q}/from${q}, {}, ${q}dir${q}); const title = ${q}from a folder${q}`),
      [],
    );
  });

  it('finds imports inside template expressions and decodes escaped specifiers', () => {
    const q = "'",
      tick = '`';
    const source = `const value = ${tick}result: \${await import(${q}#tree${q})}${tick}; import ${q}#ser\\x76er${q}`;
    assert.deepEqual(specifiers(source), ['#tree', '#server']);
    assert.equal(allowed(join(kernelDir, 'guard.ts'), 'typescript'), false);
  });

  it('rejects the old layers, other packages and paths leaving src', () => {
    const file = join(kernelDir, 'contract', 'x.ts');
    for (const spec of [
      '#tree',
      '#tree/cache',
      '#server/actions',
      '#schema/load',
      '#chain',
      '../../sub/watch',
      '../../../package.json',
      '@treenx/core/kernel',
      'sift',
    ])
      assert.equal(allowed(file, spec), false, spec);
  });

  it('admits native discovery only at the instance composition boundary', () => {
    assert.equal(allowed(join(kernelDir, 'instance.ts'), '#mod/loader'), true);
    assert.equal(allowed(join(kernelDir, 'writer.ts'), '#mod/loader'), false);
    assert.equal(allowed(join(kernelDir, 'instance.ts'), '#mod/prefab'), false);
    for (const [owner, imports] of Object.entries(OWNER_IMPORTS))
      for (const target of imports) {
        const spec =
          target.startsWith('tsx/') || target === 'quickjs-emscripten' ? target : `#${target}`;
        assert.equal(allowed(join(kernelDir, owner), spec), true, `${owner}: ${spec}`);
        assert.equal(allowed(join(kernelDir, 'writer.ts'), spec), false, spec);
      }
  });
});
