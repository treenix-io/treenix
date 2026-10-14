// create-treenix mod create <name>
// Scaffolds a new mod inside the current project's mods/ directory

import { cancel, isCancel, log, text } from '@clack/prompts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function toClassName(name: string): string {
  return name
    .split('-')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
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

function moduleOwner(modsDir: string, name: string): string {
  let directory = modsDir;
  for (;;) {
    const packagePath = join(directory, 'package.json');
    if (existsSync(packagePath)) {
      const declaration: { name?: unknown } = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (typeof declaration.name !== 'string' || declaration.name.length === 0)
        throw new TypeError('Native modules require a named package');
      return `${declaration.name}/${name}`;
    }
    const parent = resolve(directory, '..');
    if (parent === directory) throw new TypeError('Native modules require a named package');
    directory = parent;
  }
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
      validate: (v) => {
        if (!v.length) return 'Required';
        if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'Lowercase letters, numbers, hyphens only';
      },
    });
    if (isCancel(result)) {
      cancel();
      process.exit(0);
    }
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
  const owner = moduleOwner(modsDir, name);

  mkdirSync(modDir, { recursive: true });

  writeFileSync(
    join(modDir, 'types.ts'),
    `import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

export class ${cls} {
  title = '';
}

export const clientModules = [declareOpenModule(${JSON.stringify(owner + '/types')}, [], [declareClientType('${name}', ${cls})])];
`,
  );

  writeFileSync(
    join(modDir, 'seed.ts'),
    `import { nativeSeed } from '@treenx/mods/prefab/seed';

export const seeds = nativeSeed('${name}', [
  { $path: '${name}', $type: 'dir' },
  { $path: '${name}/example', $type: '${name}', title: 'Example' },
]);
`,
  );

  writeFileSync(
    join(modDir, 'view.tsx'),
    `import React from 'react';
import { view } from '@treenx/react';
import { declareClientModule } from '@treenx/react/context/client-registry';
import { ${cls} } from './types';

export const clientModules = [declareClientModule(${JSON.stringify(owner + '/view')}, [view(${cls}, ({ value }) => (
  <div className="p-4">
    <h2 className="text-lg font-bold">{value.title}</h2>
  </div>
))])];
`,
  );

  writeFileSync(
    join(modDir, 'kernel.ts'),
    `import { normalizeType } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import { buildTypeDef } from '@treenx/core/kernel/typedef';
import { readSchemasFromDir } from '@treenx/core/schema/load';
import { ${cls} } from './types';
import { seeds } from './seed';

export default function createNativeModule(): NativeModuleDeployment {
  const id = ${JSON.stringify(owner)};
  const name = normalizeType(${cls});
  const schema = readSchemasFromDir(new URL('./schemas/', import.meta.url).pathname).find(schema => schema.$id === name);
  if (schema === undefined) throw new KernelError('INVALID', 'Generate the authored module schema before loading it');
  const type = buildTypeDef(${cls}, { name, module: id, security: 'ordinary', schema });
  return { manifest: { ...declareOpenModule(id, [
    { type: name, context: 'class', handler: ${cls} },
    { type: name, context: 'schema', handler: () => schema },
    ...Object.entries(type.actions).map(([action, handler]) => ({ type: name, context: 'action:' + action, handler })),
  ]), types: [type], security: [] }, seeds };
}
`,
  );

  addToRootSeeds(name);

  log.success(`Created mod "${name}"`);
  console.log(`
  ${modDir}/
    types.ts   — fields and actions
    view.tsx   — custom view
    seed.ts    — initial data
    kernel.ts  — native module factory

  Next:
    1. Edit types.ts
    2. Run npm run schema
    3. Restart the dev server
    4. Visit /t/${name}/example
`);
}
