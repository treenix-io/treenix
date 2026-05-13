// create-treenix mod create <name>
// Scaffolds a new mod inside the current project's mods/ directory

import { cancel, isCancel, log, text } from '@clack/prompts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function toClassName(name: string): string {
  return name.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('');
}

function findModsDir(): string {
  // Walk up looking for root.json (project root marker)
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'root.json'))) {
      // Prefer mods/ in project root, fallback to src/mods/
      const mods = join(dir, 'mods');
      const srcMods = join(dir, 'src/mods');
      if (existsSync(mods)) return mods;
      if (existsSync(srcMods)) return srcMods;
      // Default: create mods/
      return mods;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve('mods');
}

function addToRootSeeds(name: string) {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const rootPath = join(dir, 'root.json');
    if (existsSync(rootPath)) {
      const root = JSON.parse(readFileSync(rootPath, 'utf8'));
      if (Array.isArray(root.seeds) && !root.seeds.includes(name)) {
        root.seeds.push(name);
        writeFileSync(rootPath, JSON.stringify(root, null, 2) + '\n');
        log.info(`Added "${name}" to root.json seeds`);
      }
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
}

export async function modCreate(args: string[], yes: boolean) {
  let name = args[0];

  if (!name && yes) {
    log.error('Mod name required in non-interactive mode');
    process.exit(1);
  }

  if (!name) {
    const result = await text({
      message: 'Mod name',
      placeholder: 'my-mod',
      validate: v => {
        if (!v.length) return 'Required';
        if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'Lowercase letters, numbers, hyphens only';
      },
    });
    if (isCancel(result)) { cancel(); process.exit(0); }
    name = String(result);
  }

  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    log.error(`Invalid mod name "${name}". Use lowercase letters, numbers, hyphens.`);
    process.exit(1);
  }

  const modsDir = findModsDir();
  const modDir = join(modsDir, name);

  if (existsSync(modDir)) {
    log.error(`Mod "${name}" already exists at ${modDir}`);
    process.exit(1);
  }

  const cls = toClassName(name);

  mkdirSync(modDir, { recursive: true });

  writeFileSync(join(modDir, 'types.ts'),
`import { registerType } from '@treenx/core/comp';

export class ${cls} {
  title = '';
}

registerType('${name}', ${cls});
`);

  writeFileSync(join(modDir, 'seed.ts'),
`import { registerPrefab } from '@treenx/core/mod';

registerPrefab('${name}', 'seed', [
  { $path: '${name}', $type: 'dir' },
  { $path: '${name}/example', $type: '${name}', title: 'Example' },
]);
`);

  writeFileSync(join(modDir, 'view.tsx'),
`import { view } from '@treenx/react';
import { ${cls} } from './types';

view(${cls}, ({ value }) => (
  <div className="p-4">
    <h2 className="text-lg font-bold">{value.title}</h2>
  </div>
));
`);

  addToRootSeeds(name);

  log.success(`Created mod "${name}"`);
  console.log(`
  ${modDir}/
    types.ts   — fields and actions
    view.tsx   — custom view
    seed.ts    — initial data

  Next:
    1. Edit types.ts
    2. Restart the dev server
    3. Visit /t/${name}/example
`);
}
