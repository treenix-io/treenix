import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const kernelDir = dirname(fileURLToPath(import.meta.url))
const srcDir = dirname(kernelDir)

// The kernel stands on Layer 0 and pure helpers only, so the old pipeline cannot leak into it.
// Packages other than node built-ins are refused until one is admitted here with a reason.
const ALLOWED = ['kernel', 'core', 'util', 'comp', 'schema/types']

type PackageImports = { readonly [key: string]: { readonly development: string } }
const packageImports: PackageImports = JSON.parse(readFileSync(join(srcDir, '../package.json'), 'utf8')).imports

// Over-approximates: every from or import followed by a quoted specifier counts, in comments too.
const SPECIFIER = /(?<![\w$.])(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1])
}

function packageTarget(spec: string): string {
  const exact = packageImports[spec]
  if (exact) return exact.development

  for (const [key, target] of Object.entries(packageImports)) {
    const [prefix, suffix] = key.split('*')
    if (suffix !== undefined && spec.startsWith(prefix) && spec.endsWith(suffix))
      return target.development.replace('*', spec.slice(prefix.length, spec.length - suffix.length))
  }

  throw new Error(`${spec} is not in the package imports map`)
}

function allowed(file: string, spec: string): boolean {
  if (spec.startsWith('node:')) return true

  const local = spec.startsWith('.') ? resolve(dirname(file), spec)
    : spec.startsWith('#') ? resolve(srcDir, '..', packageTarget(spec))
    : null
  if (local === null) return false

  const target = relative(srcDir, local).replace(/\.tsx?$/, '')
  return ALLOWED.some((area) => target === area || target.startsWith(`${area}/`))
}

function kernelFiles(): string[] {
  return readdirSync(kernelDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(kernelDir, name))
}

describe('kernel import boundary', () => {
  it('kernel files import only the kernel, Layer 0, util, comp and schema types', () => {
    const imports = kernelFiles().flatMap((file) =>
      specifiers(readFileSync(file, 'utf8')).map((spec) => ({ file, spec })))

    assert.ok(imports.length > 0)
    assert.deepEqual(
      imports.filter(({ file, spec }) => !allowed(file, spec)).map(({ file, spec }) => `${relative(srcDir, file)}: ${spec}`),
      [],
    )
  })

  it('finds every import form, multi-line and type-only included', () => {
    // Quotes go through q so that scanning this file does not read the fixture as its imports.
    const q = "'"
    const source = [
      `import type { A } from ${q}#tree${q}`,
      `import {`,
      `  b,`,
      `} from ${q}#server/actions${q}`,
      `export * from ${q}./types${q}`,
      `import ${q}#sub${q}`,
      `const m = await import(${q}#mount${q})`,
      `const n = Array.from(${q}xy${q})`,
    ].join('\n')

    assert.deepEqual(specifiers(source), ['#tree', '#server/actions', './types', '#sub', '#mount'])
  })

  it('admits the allowed areas and node built-ins', () => {
    const file = join(kernelDir, 'contract', 'x.ts')
    for (const spec of ['../types', '#kernel/types', '#core', '#core/path', '#util/ulid', '#comp', '#comp/needs', '#schema/types', 'node:fs'])
      assert.equal(allowed(file, spec), true, spec)
  })

  it('rejects the old layers, other packages and paths leaving src', () => {
    const file = join(kernelDir, 'contract', 'x.ts')
    for (const spec of ['#tree', '#tree/cache', '#server/actions', '#schema/load', '#chain', '../../sub/watch', '../../../package.json', '@treenx/core/kernel', 'immer'])
      assert.equal(allowed(file, spec), false, spec)
  })
})
