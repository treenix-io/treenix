// Treenix Tree FS helpers — Layer 1
// Shared infrastructure between fs.ts (JSON-as-data persistence) and
// mimefs.ts (real-file MIME representation). Pure helpers — no Tree
// implementation, no node:fs dependency in callers other than these.

import type { NodeData } from '#core';
import { isInsideRoot } from '#core/path';
import { OpError } from '#errors';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ChildEntry, ScanChildrenOpts } from './index';

// ── Path safety ──
// Verify `file` (already resolved to an absolute path) is inside `rootDir`,
// and that symlinks along the path do not escape root. Throws OpError(FORBIDDEN)
// on violation. ENOENT for the file itself is allowed — checks parent
// directory instead so writes to not-yet-existing paths are still gated.

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

// ── scanChildren cursor pattern ──
// Adapter total order = `$path` ASC. Cursor = `node.$path`. Caller passes
// already-collected nodes (depth-walked); this helper sorts, applies the
// exclusive `after` cursor, checks abort between yields, and emits
// ChildEntry one at a time. Used by memory/fs/mimefs scanChildren so the
// cursor semantics are guaranteed identical.

export async function* scanFromCollected(
  nodes: NodeData[],
  opts?: ScanChildrenOpts,
): AsyncIterable<ChildEntry> {
  const signal = opts?.signal;
  if (signal?.aborted) throw signal.reason;

  const after = opts?.after;
  const sorted = [...nodes].sort((a, b) =>
    a.$path < b.$path ? -1 : a.$path > b.$path ? 1 : 0,
  );

  for (const node of sorted) {
    if (signal?.aborted) throw signal.reason;
    const cursor = node.$path;
    if (after !== undefined && cursor <= after) continue;
    yield { node, cursor };
  }
}
