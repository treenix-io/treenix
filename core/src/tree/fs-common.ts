// Treenix Tree FS helpers — Layer 1
// Shared infrastructure between fs.ts (JSON-as-data persistence) and
// mimefs.ts (real-file MIME representation). Pure helpers — no Tree
// implementation, no node:fs dependency in callers other than these.

import type { NodeData } from '#core';
import type { ChildEntry, ScanChildrenOpts } from './index';

// Pure helpers — no node:* deps. Reachable from React bundles via
// tree/index.ts → must stay browser-safe. FS-specific path checks live
// in path-safety.ts which IS server-only.

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
