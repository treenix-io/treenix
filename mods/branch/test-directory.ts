import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Retain each native fixture in the project temp directory, including on a fresh checkout. */
export async function createTestDirectory(prefix: string): Promise<string> {
  const parent = fileURLToPath(new URL('../../../temp/branch-fixtures/', import.meta.url));
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}
