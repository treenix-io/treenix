import { mapNodeForSift } from '#kernel/store/keys';
// Treenix RawFS Tree — Layer 1
// Bidirectional tree that maps real filesystem files to typed nodes.
// Files become nodes with $type from mime type. Directories become $type "dir".
// "decode" context: file → node (read). "encode" context: node → file (write).

import type { NodeData } from '#core';
import { resolve as ctxResolve } from '#core/registry';
import { createSiftTest } from '#kernel/expr';
import { DEFAULT_LIMITS } from '#kernel/types';
import { mkdir, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { scanFromCollected } from './fs-common';
import { assertPathSafe } from './path-safety';
import { paginate, readWork, type TreeSource } from './index';
import './json-codec'; // register JSON decode handler
import { patchViaSet } from './patch';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown',
  '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.env': 'application/x-env',
};

function getMime(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

// outerPath: nodePath as seen by clients (after mount-prefix). Decoders may need it
// to resolve self-referential paths inside file content (e.g. relative markdown links).
// Encoders receive the same outerPath so they can preserve those relative forms when
// serializing back — without it, an absolute path is the only honest fallback.
// nodePath: tree path as the rawfs sees it (without mount prefix).
export type DecodeHandler = (filePath: string, nodePath: string, outerPath?: string) => Promise<NodeData>;
export type EncodeHandler = (node: NodeData, filePath: string, outerPath?: string) => Promise<void>;

declare module '#core/context' {
  interface ContextHandlers {
    decode: DecodeHandler;
    encode: EncodeHandler;
  }
}

export async function createRawFsTree(rootDir: string, mountPath: string = ''): Promise<TreeSource> {
  rootDir = await realpath(resolve(rootDir));
  // Normalize mount prefix: strip trailing slash, treat '/' or '' as no prefix.
  // Used only to build outerPath for decoders — not for filesystem resolution.
  const prefix = !mountPath || mountPath === '/'
    ? ''
    : mountPath.endsWith('/') ? mountPath.slice(0, -1) : mountPath;
  const toOuter = (innerPath: string): string => {
    if (!prefix) return innerPath;
    if (innerPath === '/') return prefix;
    return prefix + innerPath;
  };

  async function safeFilePath(path: string): Promise<string> {
    const full = resolve(join(rootDir, path));
    await assertPathSafe(rootDir, full);
    return full;
  }

  async function fileToNode(filePath: string, nodePath: string): Promise<NodeData> {
    const st = await stat(filePath);

    if (st.isDirectory()) {
      return { $path: nodePath, $type: 'dir' } as NodeData;
    }

    const mime = getMime(filePath);

    const decode = ctxResolve(mime, 'decode');
    if (decode) return decode(filePath, nodePath, toOuter(nodePath));

    return {
      $path: nodePath,
      $type: mime,
      meta: { size: st.size, modified: st.mtime.toISOString(), created: st.birthtime.toISOString() },
    } as NodeData;
  }

  async function collectDescendants(parent: string, depth: number): Promise<NodeData[]> {
    const deep = depth < 0; // -1 (any negative) = all descendants
    const dir = await safeFilePath(parent);
    const results: NodeData[] = [];

    async function walk(dirPath: string, parentNodePath: string, currentDepth: number) {
      if (!deep && currentDepth > depth) return;
      let entries;
      try { entries = await readdir(dirPath, { withFileTypes: true }); }
      catch (e: any) { if (e?.code === 'ENOENT') return; throw e; }

      for (const e of entries) {
        if (e.name.startsWith('.')) continue; // skip hidden files
        if (e.isSymbolicLink()) continue;
        const nodePath = parentNodePath === '/' ? `/${e.name}` : `${parentNodePath}/${e.name}`;
        const filePath = await safeFilePath(nodePath);
        results.push(await fileToNode(filePath, nodePath));

        if (e.isDirectory() && (deep || currentDepth < depth)) {
          await walk(filePath, nodePath, currentDepth + 1);
        }
      }
    }

    await walk(dir, parent, 1);
    return results;
  }

  const tree: TreeSource = {
    async get(path) {
      const file = await safeFilePath(path);
      try {
        return await fileToNode(file, path);
      } catch (e: any) {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      }
    },

    async getChildren(parent, opts) {
      const test = opts?.query ? createSiftTest(opts.query, DEFAULT_LIMITS) : null;
      const depth = opts?.depth ?? 1;
      let filtered = await collectDescendants(parent, depth);
      if (test) {
        const work = readWork(opts);
        filtered = filtered.filter(n => test(mapNodeForSift(n), work));
      }
      return paginate(filtered, opts);
    },

    // mimefs paths preserve file extensions; total-order semantics live in
    // scanFromCollected (sort + after-exclusive + signal gating).
    async *scanChildren(parent, opts) {
      const collected = await collectDescendants(parent, opts?.depth ?? 1);
      yield* scanFromCollected(collected, opts);
    },

    async set(node) {
      const filePath = await safeFilePath(node.$path);
      const encode = ctxResolve(node.$type, 'encode');
      if (!encode) throw new Error(`No encode registered for type "${node.$type}"`);

      // Receipt before-image: one decode of the current file (core-ns6p.2).
      // mimefs has no $rev lifecycle, so this read is purely for the receipt.
      const before = await tree.get(node.$path);

      await mkdir(dirname(filePath), { recursive: true });
      await encode(node, filePath, toOuter(node.$path));
      return { changes: [{ path: node.$path, before: before ?? null, after: { ...node } }] };
    },

    async remove(path) {
      const filePath = await safeFilePath(path);
      try {
        const before = await tree.get(path);
        const st = await stat(filePath);
        if (st.isDirectory()) {
          await rmdir(filePath);
        } else {
          await unlink(filePath);
        }
        return { changes: [{ path, before: before ?? null, after: null }] };
      } catch (e: any) {
        if (e.code === 'ENOENT') return { changes: [] };
        throw e;
      }
    },

    async patch(path, ops, ctx) {
      return patchViaSet(tree, path, ops, ctx);
    },
  };

  return tree;
}
