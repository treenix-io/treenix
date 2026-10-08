// Filesystem path safety — server-only. Imports node:fs/node:path at module
// top, so this file MUST NOT be reachable from React/browser bundles.

import { isInsideRoot } from '#core/path';
import { KernelError } from '#errors';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Verify `file` (resolved absolute) is inside `rootDir`, and that symlinks
 *  along the path don't escape root. A not-yet-existing path is judged by its
 *  nearest EXISTING ancestor: checking only the parent let a symlinked dir two
 *  levels up pass when both the file and its parent were missing — mkdir -p
 *  and the write then landed outside the root. */
export async function assertPathSafe(rootDir: string, file: string): Promise<void> {
  const target = resolve(file);
  if (!isInsideRoot(rootDir, target)) {
    throw new KernelError('FORBIDDEN', 'Path traversal blocked');
  }
  for (let p = target; ; p = dirname(p)) {
    let real: string;
    try {
      real = await realpath(p);
    } catch (e) {
      const missing = typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
      if (missing && p !== dirname(p)) continue;
      throw e;
    }
    if (!isInsideRoot(rootDir, real)) throw new KernelError('FORBIDDEN', 'Path escaped root via symlink');
    return;
  }
}
