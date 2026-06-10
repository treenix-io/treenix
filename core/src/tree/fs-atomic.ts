// Atomic + durable write: tmp file in the same dir → fsync → rename over target.
// In-place writeFile tears on crash: a kill mid-write leaves truncated JSON at the
// node's path and parseNode then throws forever with no repair path. rename(2) is
// atomic on POSIX, so readers see either the old node or the new one, never a mix.
// Orphaned tmp files from a crash are inert — readers only parse *.json / $.json.
// Server-only (node:fs) — kept out of fs-common.ts, which must stay browser-safe.

import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

let tmpSeq = 0;
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = join(dirname(file), `.${process.pid}.${tmpSeq++}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    // best-effort cleanup; a leftover tmp is inert (never parsed), original error wins
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
