// Load generated JSON schemas into core registry
// Import this BEFORE any defineComponent/registerType calls (import order matters in ESM)

import { normalizeType, register } from '#core';
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('./generated', import.meta.url).pathname;

export function loadSchemas() {
// TODO load async, wrap with function, call from some init
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
      if (!raw) throw new Error(`[schema] empty file: ${file}`);
      const schema = JSON.parse(raw);
      if (!schema.$id) throw new Error(`[schema] no $id: ${file}`);
      schema.$id = normalizeType(schema.$id);
      register(schema.$id, 'schema', () => schema);
    }
  }
}

loadSchemas();
