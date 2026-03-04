import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as ts from 'typescript';
import { collectJSDoc } from './extract-schemas';

const require = createRequire(import.meta.url);

function createProgram() {
  const tsconfigPath = path.resolve(import.meta.dirname, '../../tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error)
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

describe('extract-schemas: JSDoc on method data-argument properties', () => {
  let program: ts.Program;
  let checker: ts.TypeChecker;

  function findClass(name: string): ts.ClassDeclaration | undefined {
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      let found: ts.ClassDeclaration | undefined;
      sf.forEachChild(function visit(node) {
        if (ts.isClassDeclaration(node) && node.name?.text === name) found = node;
        node.forEachChild(visit);
      });
      if (found) return found;
    }
  }

  function getMethodDataProperties(cls: ts.ClassDeclaration, methodName: string) {
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name!) || member.name.text !== methodName) continue;
      const sig = checker.getSignatureFromDeclaration(member);
      if (!sig) continue;
      const dataParam = sig.parameters[0];
      if (!dataParam) continue;
      return checker.getTypeOfSymbol(dataParam).getProperties();
    }
    return [];
  }

  it('collectJSDoc extracts inline JSDoc from type literal properties', () => {
    program = createProgram();
    checker = program.getTypeChecker();

    const cls = findClass('Autostart');
    assert.ok(cls, 'Autostart class not found');

    const props = getMethodDataProperties(cls, 'start');
    assert.ok(props.length > 0, 'start method should have data properties');

    const pathProp = props.find(p => p.name === 'path');
    assert.ok(pathProp, 'path property not found in start data');

    const decl = pathProp.valueDeclaration;
    assert.ok(decl, 'path property has no valueDeclaration');

    const doc = collectJSDoc(decl);
    assert.ok(
      doc.title || doc.description,
      `JSDoc not collected from inline property. Got: ${JSON.stringify(doc)}. ` +
      `Node kind: ${ts.SyntaxKind[decl.kind]}`,
    );
  });

  it('generated autostart schema has description on start.path argument', () => {
    const schema = require('./generated/autostart.json');
    const pathProp = schema.methods?.start?.arguments?.[0]?.properties?.path;
    assert.ok(pathProp, 'path property missing from start method data argument');
    assert.ok(
      pathProp.title || pathProp.description,
      `path should have title or description from JSDoc. Got: ${JSON.stringify(pathProp)}`,
    );
  });
});
