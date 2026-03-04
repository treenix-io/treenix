// Vite plugin — auto-discover mod client.ts files outside vite root.
// Scans mods/*/client.ts and core/src/mods/*/client.ts at dev-server start,
// serves them as a virtual module: `import 'virtual:mod-clients'`.
// HMR: adding a new mod requires a dev-server restart (same as import.meta.glob).

import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:mod-clients';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

export default function modsPlugin(): Plugin {
  const root = resolve(import.meta.dirname, '../..');

  return {
    name: 'treenity-mods',

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },

    load(id) {
      if (id !== RESOLVED_ID) return;

      const imports: string[] = [];

      // Domain mods: <root>/mods/*/client.ts
      const modsDir = resolve(root, 'mods');
      if (existsSync(modsDir)) {
        for (const name of readdirSync(modsDir, { withFileTypes: true })) {
          if (!name.isDirectory()) continue;
          const client = resolve(modsDir, name.name, 'client.ts');
          if (existsSync(client)) imports.push(client);
        }
      }

      // Core mods: <root>/core/src/mods/*/client.ts
      const coreModsDir = resolve(root, 'core/src/mods');
      if (existsSync(coreModsDir)) {
        for (const name of readdirSync(coreModsDir, { withFileTypes: true })) {
          if (!name.isDirectory()) continue;
          const client = resolve(coreModsDir, name.name, 'client.ts');
          if (existsSync(client)) imports.push(client);
        }
      }

      const code = imports.map(p => `import '${p}';`).join('\n');
      return code + '\n';
    },
  };
}
