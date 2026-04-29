#!/usr/bin/env node
// Post-build:
// - rewrite #subpath imports → relative paths in dist/
// - add .js to relative ESM imports/exports in JS and declaration output
// Runs after tsc. Reads package.json "imports" field, walks dist/.
// Prevents dual-module issues in bundlers (Vite, webpack) that don't
// fully support Node.js package.json "imports" field.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const pkgPath = resolve('package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const imports = pkg.imports;
if (!imports) {
  process.exit(0);
}

const distDir = resolve('dist');

function resolveHash(specifier) {
  for (const [pattern, spec] of Object.entries(imports)) {
    if (pattern === specifier) return resolveSpec(spec);
    if (pattern.includes('*')) {
      const [prefix, suffix] = pattern.split('*');
      if (specifier.startsWith(prefix) && (!suffix || specifier.endsWith(suffix))) {
        const matched = specifier.slice(prefix.length, suffix ? -suffix.length || undefined : undefined);
        return resolveSpec(spec, matched);
      }
    }
  }
  return null;
}

function resolveSpec(spec, wildcard) {
  if (typeof spec === 'string') return tryFile(wildcard ? spec.replace('*', wildcard) : spec);
  if (Array.isArray(spec)) {
    for (const s of spec) {
      const r = tryFile(wildcard ? s.replace('*', wildcard) : s);
      if (r) return r;
    }
    return null;
  }
  if (spec.default) return resolveSpec(spec.default, wildcard);
  return null;
}

function tryFile(rel) {
  const abs = resolve(rel);
  try { statSync(abs); return abs; } catch {}
  for (const ext of ['.js', '.jsx']) {
    try { statSync(abs + ext); return abs + ext; } catch {}
  }
  return null;
}

const HASH_RE = /from\s+['"]#([^'"]+)['"]/g;
const SPEC_RE = /(\bfrom\s+['"]|^\s*import\s+['"])(\.{1,2}\/[^'"]+)(['"])/gm;
let files = 0, rewrites = 0;

function normalizeRelativeSpecifier(specifier) {
  if (specifier.endsWith('.ts') || specifier.endsWith('.tsx')) {
    return specifier.replace(/\.tsx?$/, '.js');
  }

  const last = specifier.split('/').pop() ?? '';
  if (last.includes('.')) return specifier;

  return `${specifier}.js`;
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.jsx') && !entry.name.endsWith('.d.ts')) continue;

    const src = readFileSync(full, 'utf-8');
    if (!src.includes("'#") && !src.includes('"#') && !src.includes("from './") && !src.includes('from "./') && !src.includes("import './") && !src.includes('import "./')) continue;

    let changed = false;
    let out = src.replace(HASH_RE, (match, specifier) => {
      const resolved = resolveHash('#' + specifier);
      if (!resolved) { console.warn(`  WARN: unresolved #${specifier} in ${full}`); return match; }
      let rel = relative(dirname(full), resolved);
      if (!rel.startsWith('.')) rel = './' + rel;
      changed = true;
      rewrites++;
      return `from '${rel}'`;
    });

    out = out.replace(SPEC_RE, (match, prefix, specifier, suffix) => {
      const next = normalizeRelativeSpecifier(specifier);
      if (next === specifier) return match;
      changed = true;
      rewrites++;
      return `${prefix}${next}${suffix}`;
    });

    if (changed) { writeFileSync(full, out); files++; }
  }
}

walk(distDir);
if (rewrites) console.log(`fix-hash-imports: ${rewrites} imports in ${files} files`);

// Copy non-ts assets (css, etc) to dist/. --assets-dir=DIR to override source (default: src/)
{
  const assetArg = process.argv.find(a => a.startsWith('--assets-dir='));
  const srcDir = resolve(assetArg ? assetArg.split('=')[1] : 'src');
  let copied = 0;
  const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', 'temp']);
  function copyAssets(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) copyAssets(full); continue; }
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.json')) continue;
      const rel = relative(srcDir, full);
      const dest = join(distDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(full, dest);
      copied++;
    }
  }
  copyAssets(srcDir);
  if (copied) console.log(`fix-hash-imports: copied ${copied} assets`);
}
