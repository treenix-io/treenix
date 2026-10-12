import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SUPPORTED_DATA_VERSION = 1;
export const DATA_VERSION_FILE = '.treenix-version';

/** Read the saved data marker without changing an unmarked or older backup. */
export async function readDataVersion(root: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(root, DATA_VERSION_FILE), 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }

  const version = Number(text.trim());
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(
      `${join(root, DATA_VERSION_FILE)}: corrupted version marker ${JSON.stringify(text)}`,
    );
  }

  return version;
}
