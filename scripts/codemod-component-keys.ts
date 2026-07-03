// Codemod for core-gk8.21 component namespace: inside node literals (object
// with $path), a bare key whose value carries $type is an attached component
// and must be '#'-prefixed. Reports by default (exit 1 on findings — CI-able);
// --fix rewrites in place. Review the diff: a node SNAPSHOT stored as data is
// a legit bare $type-carrier — exclude such files below if one ever appears.
//
// Usage: tsx scripts/codemod-component-keys.ts [--fix]

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const FIX = process.argv.includes('--fix');

const EXCLUDE = [
  /\/dist[-/]/, /^dist[-/]/, /\/old\//,
  /migrate-component-namespace/, // migrator + its pre-migration fixtures
  /scripts\/codemod-component-keys/,
];

type Edit = { start: number; end: number; text: string };
type Finding = { file: string; line: number; key: string };

function bareName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    const t = name.text;
    return t.startsWith('$') || t.startsWith('#') ? null : t;
  }
  return null;
}

function hasProp(obj: ts.ObjectLiteralExpression, key: string): boolean {
  return obj.properties.some(
    (p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key,
  );
}

function scanFile(file: string): { findings: Finding[]; edits: Edit[] } {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const edits: Edit[] = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node) && hasProp(node, '$path')) {
      for (const p of node.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = bareName(p.name);
        if (!key) continue;
        if (!ts.isObjectLiteralExpression(p.initializer) || !hasProp(p.initializer, '$type')) continue;
        const { line } = sf.getLineAndCharacterOfPosition(p.name.getStart(sf));
        findings.push({ file, line: line + 1, key });
        edits.push({ start: p.name.getStart(sf), end: p.name.end, text: `'#${key}'` });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (FIX && edits.length) {
    let out = src;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    writeFileSync(file, out);
  }
  return { findings, edits };
}

const files = execSync("git ls-files '*.ts' '*.tsx'", { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !EXCLUDE.some((re) => re.test(f)));

const all: Finding[] = [];
for (const f of files) all.push(...scanFile(f).findings);

for (const f of all) console.log(`${f.file}:${f.line}  ${f.key} → '#${f.key}'`);
console.log(`\n${all.length} bare component key(s)${FIX && all.length ? ' — fixed' : ''} in ${files.length} files scanned`);
if (!FIX && all.length) process.exit(1);
