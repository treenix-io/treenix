// JSON file ↔ node codec for RawFS tree
// JSON files are plain objects — no metadata wrapping

import type { NodeData } from '#core';
import { assertValidType, register, safeJsonParse } from '#core';
import { readFile } from 'node:fs/promises';

export function registerJsonCodec() {
  register('application/json', 'decode', async (filePath: string, nodePath: string) => {
    const raw = await readFile(filePath, 'utf-8');
    const obj = safeJsonParse(raw);
    const $type = obj.$type ?? 'application/json';
    assertValidType($type);
    return { ...obj, $path: nodePath, $type } as NodeData;
  });
}

registerJsonCodec();
