// Treenity FS Tree — Layer 1
// Stores nodes as JSON files on disk.
// Leaf nodes → name.json, directory nodes (with children) → name/$.json
// Auto-promotes leaf→dir when children appear, demotes dir→leaf when last child removed.

import type { NodeData } from '#core';
import { dirname as treeDirname, isChildPath } from '#core/path';
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sift from 'sift';
import type { Tree } from './index';
import { paginate } from './index';
import { defaultPatch } from './patch';
import { mapNodeForSift } from './query';

function securityCheck(root: string, file: string) {
  if (!file.startsWith(resolve(root))) throw new Error(`Path traversal blocked`);
}

export async function createFsTree(rootDir: string): Promise<Tree> {
  rootDir = resolve(rootDir);
  await mkdir(rootDir, { recursive: true });

  // Per-path write queue — serializes concurrent writes to the same file
  const writeQueues = new Map<string, Promise<void>>();
  function enqueue(path: string, fn: () => Promise<void>): Promise<void> {
    const prev = writeQueues.get(path) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const cleanup = () => { if (writeQueues.get(path) === next) writeQueues.delete(path); };
    next.then(cleanup, cleanup);
    writeQueues.set(path, next);
    return next;
  }

  // Read node from whichever form exists: dir (path/$.json) or leaf (path.json)
  async function readNode(path: string): Promise<NodeData | undefined> {
    const dirFile = resolve(join(rootDir, path, '$.json'));
    securityCheck(rootDir, dirFile);
    try {
      return JSON.parse(await readFile(dirFile, 'utf-8'));
    } catch (e: any) {
      if (e.code === 'ENOENT') { /* fall through to leaf form */ }
      else throw e; // SyntaxError = corrupted JSON, propagate loudly
    }

    if (path !== '/') {
      const leafFile = resolve(join(rootDir, path + '.json'));
      securityCheck(rootDir, leafFile);
      try {
        return JSON.parse(await readFile(leafFile, 'utf-8'));
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
    try {
      const data = await readFile(leafFile, 'utf-8');
      const dir = resolve(join(rootDir, path));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '$.json'), data);
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
      const entries = await readdir(nodeDir);
      if (entries.length === 0) await rmdir(nodeDir);
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.error(`[fs] cleanup error at ${removedPath}:`, e);
    }

    // Walk up and demote parents that lost their last child
    let current = treeDirname(removedPath);
    while (current && current !== '/') {
      const dir = resolve(join(rootDir, current));
      try {
        const entries = await readdir(dir);
        if (entries.length === 1 && entries[0] === '$.json') {
          // Only $.json remains — demote to leaf form
          const data = await readFile(join(dir, '$.json'), 'utf-8');
          await unlink(join(dir, '$.json'));
          await rmdir(dir);
          await writeFile(resolve(join(rootDir, current + '.json')), data);
        } else if (entries.length === 0) {
          await rmdir(dir);
        } else {
          break; // still has children
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') console.error(`[fs] demotion walk error at ${current}:`, e);
        break;
      }
      current = treeDirname(current);
    }
  }

  // Walk all nodes in both forms
  async function allNodes(): Promise<NodeData[]> {
    const results: NodeData[] = [];
    async function walk(dir: string) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch (e: any) {
        if (e.code === 'ENOENT') return;
        throw e;
      }

      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (e.name.endsWith('.json')) {
          results.push(JSON.parse(await readFile(full, 'utf-8')));
        }
      }
    }
    await walk(rootDir);
    return results;
  }

  const tree: Tree = {
    async get(path) {
      return readNode(path);
    },

    async getChildren(parent, opts) {
      const depth = opts?.depth ?? 1;
      const all = await allNodes();
      let filtered = all.filter((n) => {
        if (!isChildPath(parent, n.$path, false)) return false;
        if (depth === Infinity) return true;
        const rest = parent === '/' ? n.$path.slice(1) : n.$path.slice(parent.length + 1);
        return rest.split('/').length <= depth;
      });
      if (opts?.query) {
        const test = sift(opts.query);
        filtered = filtered.filter(n => test(mapNodeForSift(n)));
      }
      return paginate(filtered, opts);
    },

    async set(node) {
      return enqueue(node.$path, async () => {
        const path = node.$path;

        await promoteAncestors(path);

        // OCC check
        if (node.$rev != null) {
          const existing = await readNode(path);
          if (!existing) {
            throw new Error(`OptimisticConcurrencyError: node ${path} does not exist but $rev was provided`);
          }
          if (existing.$rev !== node.$rev) {
            throw new Error(`OptimisticConcurrencyError: node ${path} modified by another transaction. Expected $rev ${existing.$rev}, got ${node.$rev}`);
          }
        }

        node.$rev = (node.$rev ?? 0) + 1;
        const data = JSON.stringify(node, null, 2) + '\n';

        if (path === '/' || await hasChildren(path)) {
          // Dir form: has children
          const dirFile = resolve(join(rootDir, path, '$.json'));
          securityCheck(rootDir, dirFile);
          await mkdir(resolve(join(rootDir, path)), { recursive: true });
          await writeFile(dirFile, data);
          // Clean up stale leaf form
          if (path !== '/') {
            try { await unlink(resolve(join(rootDir, path + '.json'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
          }
        } else {
          // Leaf form: no children
          const leafFile = resolve(join(rootDir, path + '.json'));
          securityCheck(rootDir, leafFile);
          await mkdir(dirname(leafFile), { recursive: true });
          await writeFile(leafFile, data);
          // Clean up stale dir form + empty dir
          try { await unlink(resolve(join(rootDir, path, '$.json'))); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
          try { await rmdir(resolve(join(rootDir, path))); } catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e; }
        }
      });
    },

    async remove(path) {
      // Try dir form first
      const dirFile = resolve(join(rootDir, path, '$.json'));
      securityCheck(rootDir, dirFile);
      try {
        await unlink(dirFile);
        await cleanupAfterRemove(path);
        return true;
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Try leaf form
      if (path !== '/') {
        const leafFile = resolve(join(rootDir, path + '.json'));
        securityCheck(rootDir, leafFile);
        try {
          await unlink(leafFile);
          await cleanupAfterRemove(path);
          return true;
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
      }

      return false;
    },

    async patch(path, ops, ctx) {
      return defaultPatch(readNode, (n) => tree.set(n, ctx), path, ops, ctx);
    },
  };

  return tree;
}
