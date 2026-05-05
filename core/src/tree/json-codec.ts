// JSON file ↔ node codec for RawFS tree
// JSON files are plain objects — no metadata wrapping

import type { NodeData } from '#core';
import { register, safeJsonParse } from '#core';
import { readFile } from 'node:fs/promises';

export function registerJsonCodec() {
  register('application/json', 'decode', async (filePath: string, nodePath: string) => {
    const raw = await readFile(filePath, 'utf-8');
    const obj = safeJsonParse(raw);
    return { ...obj, $path: nodePath, $type: obj.$type ?? 'application/json' } as NodeData;
  });
}

registerJsonCodec();
