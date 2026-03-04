import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Choices } from './prompts';

// In built mode, TEMPLATES is inlined by esbuild define.
// In dev mode (tsx), we load from filesystem.
declare const TEMPLATES: Record<string, string> | undefined

function loadTemplatesFromFS(): Record<string, string> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../templates')
  const result: Record<string, string> = {}

  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else result[relative(dir, full)] = readFileSync(full, 'utf-8')
    }
  }

  walk(dir)
  return result
}

function getTemplates(): Record<string, string> {
  try { return TEMPLATES! } catch { /* dev mode */ }
  return loadTemplatesFromFS()
}

type Group = '_base' | '_frontend' | '_example'

const FRONTEND_DEPS = {
  dependencies: {
    'react': '^19.2.0',
    'react-dom': '^19.2.0',
    'tailwindcss': '^4.1.0',
  },
  devDependencies: {
    '@tailwindcss/vite': '^4.1.0',
    '@types/react': '^19.2.0',
    '@types/react-dom': '^19.2.0',
    '@vitejs/plugin-react': '^5.1.0',
    'vite': '^7.3.0',
    'vite-tsconfig-paths': '^6.1.0',
  },
}

function getGroups(choices: Choices): Group[] {
  const groups: Group[] = ['_base']
  if (choices.frontend) groups.push('_frontend')
  if (choices.exampleMod) groups.push('_example')
  return groups
}

function replaceTokens(content: string, choices: Choices): string {
  const namespace = choices.projectName.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return content
    .replaceAll('{{PROJECT_NAME}}', choices.projectName)
    .replaceAll('{{NAMESPACE}}', namespace)
}

// Rename special filenames that can't be stored as-is in templates
const FILE_RENAMES: Record<string, string> = {
  'dot-env': '.env',
  'dot-gitignore': '.gitignore',
}

function resolveRelPath(relPath: string): string {
  const parts = relPath.split('/')
  const last = parts[parts.length - 1]
  if (FILE_RENAMES[last]) parts[parts.length - 1] = FILE_RENAMES[last]
  return parts.join('/')
}

export function scaffold(targetDir: string, choices: Choices) {
  const templates = getTemplates()
  const groups = getGroups(choices)
  const pkgJsonParts: string[] = []

  for (const [tmplPath, content] of Object.entries(templates)) {
    const group = tmplPath.split('/')[0] as Group
    if (!groups.includes(group)) continue

    // Strip group prefix and .tmpl suffix
    let relPath = tmplPath.slice(group.length + 1).replace(/\.tmpl$/, '')
    relPath = resolveRelPath(relPath)

    // Collect package.json — merge at the end
    if (relPath === 'package.json') {
      pkgJsonParts.push(content)
      continue
    }

    const outPath = join(targetDir, relPath)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, replaceTokens(content, choices))
  }

  // Merge and write package.json
  const basePkg = JSON.parse(replaceTokens(pkgJsonParts[0], choices))
  if (choices.frontend) {
    Object.assign(basePkg.dependencies, FRONTEND_DEPS.dependencies)
    Object.assign(basePkg.devDependencies, FRONTEND_DEPS.devDependencies)
  }
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify(basePkg, null, 2) + '\n')

  // Create data dirs
  mkdirSync(join(targetDir, 'data/base'), { recursive: true })
  mkdirSync(join(targetDir, 'data/work'), { recursive: true })
  mkdirSync(join(targetDir, 'src/mods'), { recursive: true })
}
