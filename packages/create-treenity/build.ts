// Build create-treenity CLI → single dist/index.js with templates inlined

import { buildSync } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// 1. Collect all template files into a JSON map
function collectTemplates(dir: string): Record<string, string> {
  const result: Record<string, string> = {}

  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        const rel = relative(dir, full)
        result[rel] = readFileSync(full, 'utf-8')
      }
    }
  }

  walk(dir)
  return result
}

const templates = collectTemplates('templates')

// 2. Generate templates module
mkdirSync('src', { recursive: true })
writeFileSync(
  'src/_templates.gen.ts',
  `// Auto-generated — do not edit\nexport const TEMPLATES: Record<string, string> = ${JSON.stringify(templates, null, 2)};\n`,
)

// 3. Bundle
mkdirSync('dist', { recursive: true })
buildSync({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    TEMPLATES: JSON.stringify(templates),
  },
})

console.log('built → dist/index.js')
