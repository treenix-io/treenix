// Treenix FS Tree — Layer 1
// Stores nodes as JSON files on disk.
// Leaf nodes → name.json, directory nodes (with children) → name/$.json
// Auto-promotes leaf→dir when children appear, demotes dir→leaf when last child removed.

import type { NodeData } from '#core';
import { assertValidType, safeJsonParse } from '#core';
import { dirname as treeDirname } from '#core/path';
import { KernelError } from '#errors';
import { createSiftTest } from '#kernel/expr';
import { mkdir, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite } from './fs-atomic';
import { scanFromCollected } from './fs-common';
import { ensureMigrated } from './migrate-component-namespace';
import { assertPathSafe } from './path-safety';
import { applyPatchManyEntry, assertPatchManyBatch, assertSetEntryOcc, isSetEntry, mapNodeForSift, paginate, type TreeSource } from './index';
import { type CommitChange, type CommitReceipt, hasMutationOps, patchViaSet } from './patch';

// A dir-form node lives at <path>/$.json, so a '$' path segment aliases that
// file: set('/a/$') overwrote node /a, and set('/a/$/c') moved /a's file away —
// a writer on /a's subtree could strip /a's $acl.
function assertFsPath(path: string): void {
  if (path.split('/').includes('$')) throw new KernelError('INVALID', `fs: path segment "$" is reserved: ${path}`);
}

export async function createFsTree(rootDir: string): Promise<TreeSource> {
  await mkdir(resolve(rootDir), { recursive: true });
  rootDir = await realpath(resolve(rootDir));

  // Data-format gate: strict '#' readers must never see a pre-namespace root.
  await ensureMigrated(rootDir);

  // Serialize ALL mutations on one chain. promote/demote/leaf-cleanup mutate a node's
  // parent and child paths, so per-path locking can't prevent set/set and set/remove races.
  let writeChain: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = writeChain.then(fn, fn);
    writeChain = result.then(() => {}, () => {});
    return result;
  }

  // Parse a JSON file into NodeData, stamping $path from the logical tree path.
  // On-disk body has no $path — file location is authoritative.
  async function parseNode(file: string, path: string): Promise<NodeData> {
    const obj = safeJsonParse(await readFile(file, 'utf-8'));
    assertValidType(obj.$type);
    obj.$path = path;
    return obj;
  }

  // Read node from whichever form exists: dir (path/$.json) or leaf (path.json)
  async function readNode(path: string): Promise<NodeData | undefined> {
    assertFsPath(path);
    const dirFile = resolve(join(rootDir, path, '$.json'));
    await assertPathSafe(rootDir, dirFile);
    try {
      return await parseNode(dirFile, path);
    } catch (e: any) {
      if (e.code === 'ENOENT') { /* fall through to leaf form */ }
      else throw e; // SyntaxError = corrupted JSON, propagate loudly
    }

    if (path !== '/') {
      const leafFile = resolve(join(rootDir, path + '.json'));
      await assertPathSafe(rootDir, leafFile);
      try {
        return await parseNode(leafFile, path);
      } catch (e: any) {
        if (e.code === 'ENOENT') { /* not found */ }
        else throw e;
      }
    }

    return undefined;
  }

  // Promote a node from leaf form (path.json) to dir form (path/$.json)
  async function promoteIfNeeded(path: string): Promise<void> {
    if (path === '/') return;
    const leafFile = resolve(join(rootDir, path + '.json'));
    await assertPathSafe(rootDir, leafFile);
    try {
      const data = await readFile(leafFile, 'utf-8');
      const dir = resolve(join(rootDir, path));
      await assertPathSafe(rootDir, dir);
      const dirFile = join(dir, '$.json');
      await assertPathSafe(rootDir, dirFile);
      await mkdir(dir, { recursive: true });
      await atomicWrite(dirFile, data);
      await unlink(leafFile);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  // Promote all ancestors that might be in leaf form
  async function promoteAncestors(path: string): Promise<void> {
    const parts = path === '/' ? [] : path.slice(1).split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      await promoteIfNeeded('/' + parts.slice(0, i + 1).join('/'));
    }
  }

  // Check if a node's directory has children (entries beyond $.json)
  async function hasChildren(path: string): Promise<boolean> {
    const dir = resolve(join(rootDir, path));
    await assertPathSafe(rootDir, dir);
    try {
      const entries = await readdir(dir);
      return entries.some(e => e !== '$.json');
    } catch (e: any) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  // After removing a node, clean up empty dirs and demote childless parents
  async function cleanupAfterRemove(removedPath: string): Promise<void> {
    // Remove the node's now-empty directory if it exists
    try {
      const nodeDir = resolve(join(rootDir, removedPath));
      await assertPathSafe(rootDir, nodeDir);
      const entries = await readdir(nodeDir);
      if (entries.length === 0) await rmdir(nodeDir);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }

    // Walk up and demote parents that lost their last child
    let current = treeDirname(removedPath);
    while (current && current !== '/') {
      const dir = resolve(join(rootDir, current));
      try {
        await assertPathSafe(rootDir, dir);
        const entries = await readdir(dir);
        if (entries.length === 1 && entries[0] === '$.json') {
          // Only $.json remains — demote to leaf form. Write the leaf FIRST (same safe
          // order as promoteIfNeeded) so a failing unlink/rmdir can't destroy node data.
          const dirFile = join(dir, '$.json');
          await assertPathSafe(rootDir, dirFile);
          const leafFile = resolve(join(rootDir, current + '.json'));
          await assertPathSafe(rootDir, leafFile);
          const data = await readFile(dirFile, 'utf-8');
          await atomicWrite(leafFile, data);
          await unlink(dirFile);
          await rmdir(dir);
        } else if (entries.length === 0) {
          await rmdir(dir);
        } else {
          break; // still has children
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        break;
      }
      current = treeDirname(current);
    }
  }

  // Collect children of a tree path up to given depth by walking only the relevant FS subtree
  async function collectChildren(parent: string, depth: number): Promise<NodeData[]> {
    assertFsPath(parent);
    const results: NodeData[] = [];
    const deep = depth < 0; // -1 (any negative) = all descendants
    const fsDir = resolve(join(rootDir, parent));
    await assertPathSafe(rootDir, fsDir);

    async function walk(dir: string, currentDepth: number) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch (e: any) {
        if (e.code === 'ENOENT') return;
        throw e;
      }

      for (const e of entries) {
        if (e.name === '$.json') continue; // parent's own data, not a child
        if (e.isSymbolicLink()) continue; // skip symlinks — security hardening
        const full = resolve(join(dir, e.name));
        await assertPathSafe(rootDir, full);

        if (e.isDirectory()) {
          // Directory child — read its $.json if exists
          const childPath = full.slice(rootDir.length) || '/';
          const node = await readNode(childPath);
          if (node) results.push(node);
          if (deep || currentDepth < depth) await walk(full, currentDepth + 1);
        } else if (e.name.endsWith('.json')) {
          // Leaf child — name.json. Compute logical path from FS location and stamp $path.
          const childPath = full.slice(rootDir.length).replace(/\.json$/, '');
          results.push(await parseNode(full, childPath));
        }
      }
    }

    await walk(fsDir, 1);
    return results;
  }

  // Write body shared by set() and patchMany(). Runs INSIDE locked() — set()
  // wraps it itself; patchMany() calls it per staged member under ONE lock
  // (calling tree.set from inside locked() would deadlock the write chain).
  // Returns the committed change (core-ns6p.2); the existing read doubles as
  // OCC source and before-image, so the receipt costs no extra IO on the OCC
  // path and one page-cached read on blind upserts.
  async function writeNode(node: NodeData): Promise<CommitChange> {
    const path = node.$path;
    assertFsPath(path);

    await promoteAncestors(path);

    const existing = await readNode(path);

    // OCC check
    if (node.$rev != null) {
      if (!existing) {
        throw new KernelError('CONFLICT', `OptimisticConcurrencyError: node ${path} does not exist but $rev was provided`);
      }
      if (existing.$rev !== node.$rev) {
        throw new KernelError('CONFLICT', `OptimisticConcurrencyError: node ${path} modified by another transaction. Expected $rev ${existing.$rev}, got ${node.$rev}`);
      }
    }

    // Strip $path from on-disk body — file location is authoritative.
    // Stamped back on read via parseNode. Prevents stale $path when files are copied/moved.
    const { $path: _, ...rest } = node;
    // Advance from STORED (ns6p.4 invariant 24): blind set continues the rev
    // line instead of resetting to 1. OCC path: incoming === existing above.
    rest.$rev = (existing?.$rev ?? 0) + 1;
    node.$rev = rest.$rev; // preserve caller-visible $rev bump
    const data = JSON.stringify(rest, null, 2) + '\n';

    if (path === '/' || await hasChildren(path)) {
      // Dir form: has children
      const dirFile = resolve(join(rootDir, path, '$.json'));
      await assertPathSafe(rootDir, dirFile);
      await mkdir(resolve(join(rootDir, path)), { recursive: true });
      await atomicWrite(dirFile, data);
      // Clean up stale leaf form
      if (path !== '/') {
        try { await unlink(resolve(join(rootDir, path + '.json'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
    } else {
      // Leaf form: no children
      const leafFile = resolve(join(rootDir, path + '.json'));
      await assertPathSafe(rootDir, leafFile);
      await mkdir(dirname(leafFile), { recursive: true });
      await atomicWrite(leafFile, data);
      // Clean up stale dir form + empty dir
      try { await unlink(resolve(join(rootDir, path, '$.json'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      try { await rmdir(resolve(join(rootDir, path))); } catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e; }
    }

    // After-image parsed back from the exact serialized body: an owned deep
    // snapshot with on-disk fidelity — a shallow {...rest} would alias the
    // caller's nested objects and could diverge from disk post-mutation.
    const after = safeJsonParse(data);
    after.$path = path;
    return { path, before: existing ?? null, after };
  }

  const tree: TreeSource = {
    async get(path) {
      return readNode(path);
    },

    async getChildren(parent, opts) {
      const depth = opts?.depth ?? 1;
      let filtered = await collectChildren(parent, depth);
      if (opts?.query) {
        const test = createSiftTest(opts.query);
        filtered = filtered.filter(n => test(mapNodeForSift(n)));
      }
      return paginate(filtered, opts);
    },

    // In-flight readdir/readFile in collectChildren itself isn't cancellable
    // in MVP — scanFromCollected gates the yield boundary. Stage 6 may stream.
    async *scanChildren(parent, opts) {
      const collected = await collectChildren(parent, opts?.depth ?? 1);
      yield* scanFromCollected(collected, opts);
    },

    async set(node) {
      return locked(async () => ({ changes: [await writeNode(node)] }));
    },

    async remove(path) {
      return locked(async () => {
        // Before-image for the receipt — read inside the lock, before unlink.
        const before = await readNode(path);
        const removed: CommitReceipt = { changes: before ? [{ path, before, after: null }] : [] };

        // Try dir form first
        const dirFile = resolve(join(rootDir, path, '$.json'));
        await assertPathSafe(rootDir, dirFile);
        try {
          await unlink(dirFile);
          await cleanupAfterRemove(path);
          return removed;
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }

        // Try leaf form
        if (path !== '/') {
          const leafFile = resolve(join(rootDir, path + '.json'));
          await assertPathSafe(rootDir, leafFile);
          try {
            await unlink(leafFile);
            await cleanupAfterRemove(path);
            return removed;
          } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
          }
        }

        return { changes: [] };
      });
    },

    async patch(path, ops, ctx) {
      return patchViaSet(tree, path, ops, ctx);
    },

    // ALL-OR-NOTHING under the global write chain (core-gk8.15): phase 1 reads
    // and stages every member (ops incl. test ops applied on clones) — any
    // failure throws with ZERO disk writes. Phase 2 writes sequentially via
    // atomicWrite. Trade-off: atomic against ERRORS (validate-all-first), NOT
    // against process crash mid-batch — same class as trash copies
    // (tree/policy.ts remove: a crash leaves a duplicate, never a loss).
    async patchMany(ancestor, entries, _ctx) {
      assertPatchManyBatch(ancestor, entries);
      return locked(async () => {
        const staged: NodeData[] = [];
        const guarded: CommitChange[] = [];
        for (const entry of entries) {
          if (isSetEntry(entry)) {
            // Set-member may CREATE — OCC gated here in phase 1; the clone is
            // staged UNBUMPED because phase-2 writeNode owns the re-check +
            // bump (same locked(), so the re-check cannot fail after this gate).
            assertSetEntryOcc(await readNode(entry.path), entry);
            staged.push(structuredClone(entry.node));
            continue;
          }
          const node = await readNode(entry.path);
          if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${entry.path}`);
          const copy = applyPatchManyEntry(node, entry);
          // Test-only member: evaluated, not written, no $rev bump — reported
          // as a guarded no-op member.
          if (hasMutationOps(entry.ops)) staged.push(copy);
          else guarded.push({ path: entry.path, before: copy, after: copy });
        }

        // writeNode re-checks OCC against each copy's own (unbumped) $rev and
        // bumps it — same semantics as single patch (patchViaSet → set).
        const changes: CommitChange[] = [];
        for (const n of staged) changes.push(await writeNode(n));
        return { changes: [...changes, ...guarded] };
      });
    },
  };

  return tree;
}
