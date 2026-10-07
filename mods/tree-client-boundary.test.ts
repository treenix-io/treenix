import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

const forbiddenNames = new Set(['trpc', 'cache', 'tree', 'set']);
const forbiddenModules = new Set(['tree/trpc', 'tree/cache', 'tree/client']);

function check(source: string, filename: string): string[] {
  const violations: string[] = [];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const report = (node: ts.Node) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${filename}:${line + 1}`);
  };
  const moduleName = (node: ts.Expression) => ts.isStringLiteral(node) ? node.text : undefined;
  const blocked = (name: string) => forbiddenModules.has(name.replace(/^@treenx\/react\//, '').replace(/\.(ts|js)$/, ''));
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const name = moduleName(node.moduleSpecifier);
      if (name?.startsWith('@treenx/react') && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        if (blocked(name) || ((name === '@treenx/react' || name === '@treenx/react/hooks') && bindings && ts.isNamespaceImport(bindings))) report(node);
        else if (bindings && ts.isNamedImports(bindings)) {
          for (const imported of bindings.elements) {
            if (!imported.isTypeOnly && forbiddenNames.has((imported.propertyName ?? imported.name).text)) report(imported);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const name = moduleName(node.moduleSpecifier);
      if (name?.startsWith('@treenx/react') && !node.isTypeOnly) {
        const exports = node.exportClause;
        if (blocked(name) || !exports || !ts.isNamedExports(exports)) report(node);
        else for (const exported of exports.elements) {
          if (!exported.isTypeOnly && forbiddenNames.has((exported.propertyName ?? exported.name).text)) report(exported);
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const name = node.arguments[0] && moduleName(node.arguments[0]);
      if (name === '@treenx/react' || name === '@treenx/react/hooks' || (name && blocked(name))) report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'old', 'secrets', 'temp'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

describe('mod transport boundary', () => {
  it('views import consumer operations without access to the transport or mutable cache', () => {
    const violations = [...sources(import.meta.dirname)].flatMap(path => check(readFileSync(path, 'utf8'), path));
    assert.deepEqual(violations, []);
  });

  it('rejects aliases, namespaces, focused imports and dynamic bypasses', () => {
    for (const source of [
      "import { trpc as remote } from '@treenx/react'",
      'import { set as persist } from "@treenx/react/hooks"',
      "import * as client from '@treenx/react'",
      "import { get } from '@treenx/react/tree/cache'",
      "export { tree as store } from '@treenx/react'",
      "const client = await import('@treenx/react/tree/trpc')",
    ]) assert.equal(check(source, 'view.tsx').length, 1);
    assert.deepEqual(check("import { treeClient, useSave, useActions } from '@treenx/react'", 'view.tsx'), []);
  });
});
