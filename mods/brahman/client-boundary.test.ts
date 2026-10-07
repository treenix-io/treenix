import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

it('shared action types load without importing the server sandbox', () => {
  const source = ts.createSourceFile('types.ts', readFileSync(new URL('./types.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const dependencies = source.statements.flatMap(statement =>
    ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text] : []);
  assert.ok(!dependencies.includes('./sandbox'));
});
