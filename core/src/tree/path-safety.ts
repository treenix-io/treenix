// FS adapter path safety — server-only. Imports node:fs/node:path at module
// top, so this file MUST NOT be reachable from React/browser bundles.

import { isInsideRoot } from '#core/path';
import { OpError } from '#errors';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Verify `file` (resolved absolute) is inside `rootDir`, and that symlinks
 *  along the path don't escape root. ENOENT for the file itself is allowed
 *  — checks parent dir instead so writes to not-yet-existing paths are
 *  still gated. */
export async function assertPathSafe(rootDir: string, file: string): Promise<void> {
  if (!isInsideRoot(rootDir, resolve(file))) {
    throw new OpError('FORBIDDEN', 'Path traversal blocked');
  }
  try {
    const real = await realpath(file);
    if (!isInsideRoot(rootDir, real)) {
      throw new OpError('FORBIDDEN', 'Path escaped root via symlink');
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    try {
      const parentReal = await realpath(dirname(file));
      if (!isInsideRoot(rootDir, parentReal)) {
        throw new OpError('FORBIDDEN', 'Path escaped root via symlink');
      }
    } catch (e2: any) {
      if (e2.code !== 'ENOENT') throw e2;
    }
  }
}
