// Treenix RawFS Tree — Layer 1
// Bidirectional tree that maps real filesystem files to typed nodes.
// Files become nodes with $type from mime type. Directories become $type "dir".
// "decode" context: file → node (read). "encode" context: node → file (write).

import type { NodeData } from '#core';
import { resolve as ctxResolve } from '#core/registry';
import { mkdir, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { isInsideRoot } from '#core/path';
import type { Tree } from './index';
import { paginate } from './index';
import './json-codec'; // register JSON decode handler
import { defaultPatch } from './patch';

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
// nodePath: tree path as the rawfs sees it (without mount prefix).
export type DecodeHandler = (filePath: string, nodePath: string, outerPath?: string) => Promise<NodeData>;
export type EncodeHandler = (node: NodeData, filePath: string) => Promise<void>;

declare module '#core/context' {
  interface ContextHandlers {
    decode: DecodeHandler;
    encode: EncodeHandler;
  }
}

export async function createRawFsStore(rootDir: string, mountPath: string = ''): Promise<Tree> {
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
    if (!isInsideRoot(rootDir, full)) throw new Error(`Path traversal blocked`);

    // Symlink containment: verify real path stays inside root
    try {
      const real = await realpath(full);
      if (!isInsideRoot(rootDir, real)) throw new Error('Path escaped root via symlink');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }

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

  const tree: Tree = {
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
      const dir = await safeFilePath(parent);
      const depth = opts?.depth ?? 1;

      const results: NodeData[] = [];

      async function walk(dirPath: string, parentNodePath: string, currentDepth: number) {
        if (currentDepth > depth) return;
        let entries;
        try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }

        for (const e of entries) {
          if (e.name.startsWith('.')) continue; // skip hidden files
          const filePath = join(dirPath, e.name);
          const nodePath = parentNodePath === '/' ? `/${e.name}` : `${parentNodePath}/${e.name}`;
          results.push(await fileToNode(filePath, nodePath));

          if (e.isDirectory() && currentDepth < depth) {
            await walk(filePath, nodePath, currentDepth + 1);
          }
        }
      }

      await walk(dir, parent, 1);
      return paginate(results, opts);
    },

    async set(node) {
      const filePath = await safeFilePath(node.$path);
      const encode = ctxResolve(node.$type, 'encode');
      if (!encode) throw new Error(`No encode registered for type "${node.$type}"`);

      await mkdir(dirname(filePath), { recursive: true });
      await encode(node, filePath);
    },

    async remove(path) {
      const filePath = await safeFilePath(path);
      try {
        const st = await stat(filePath);
        if (st.isDirectory()) {
          await rmdir(filePath);
        } else {
          await unlink(filePath);
        }
        return true;
      } catch (e: any) {
        if (e.code === 'ENOENT') return false;
        throw e;
      }
    },

    async patch(path, ops, ctx) {
      return defaultPatch(tree.get, tree.set, path, ops, ctx);
    },
  };

  return tree;
}
