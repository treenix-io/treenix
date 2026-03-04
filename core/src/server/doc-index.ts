// Doc RAG — BM25 search over project docs, code, and AI memory
// Indexes: docs/*.md, **/CLAUDE.md, memory/*.md, key source files (types.ts, service.ts, core)
// Chunks markdown by ## headers. Code files indexed whole (truncated).
// Used by: scripts/mcp-docs.ts (Claude Code MCP)

import { create, insertMultiple, search } from '@orama/orama';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

export type DocCategory = 'doc' | 'mod' | 'code' | 'memory' | 'config';

type DocChunk = {
  path: string;
  section: string;
  category: string;
  text: string;
  mtime: number;
};

const SCHEMA = {
  path: 'string',
  section: 'string',
  category: 'enum',
  text: 'string',
  mtime: 'number',
} as const;

type DocDB = ReturnType<typeof create<typeof SCHEMA>>;

// ── File discovery ──

const EXCLUDE = /node_modules|dist|dist-front|\.git[\/\\]|dont-read|\/old\/|\.DS_Store|bun\.lock/;

function walkDir(dir: string, exts: Set<string>, extraExclude?: RegExp): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (EXCLUDE.test(full)) continue;
      if (extraExclude?.test(full)) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (exts.has(extname(entry.name))) results.push(full);
    }
  }

  walk(dir);
  return results;
}

function categorize(filePath: string, projectRoot: string, memoryDir?: string): DocCategory {
  if (memoryDir && filePath.startsWith(memoryDir)) return 'memory';
  const rel = relative(projectRoot, filePath);
  if (basename(filePath) === 'CLAUDE.md') return rel.startsWith('src/mods/') ? 'mod' : 'config';
  if (rel.startsWith('docs/')) return 'doc';
  if (rel === 'package.json' || rel === 'tsconfig.json' || rel === 'CHANGELOG.md') return 'config';
  return 'code';
}

// ── Chunking ──

function chunkMarkdown(text: string, filePath: string): { section: string; text: string }[] {
  const chunks: { section: string; text: string }[] = [];
  const lines = text.split('\n');
  let section = basename(filePath, '.md');
  let buf: string[] = [];

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      if (buf.length) chunks.push({ section, text: buf.join('\n').trim() });
      section = m[1].trim();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) chunks.push({ section, text: buf.join('\n').trim() });

  if (chunks.length <= 1) return [{ section: basename(filePath, '.md'), text: text.trim() }];
  return chunks.filter(c => c.text.length > 20);
}

const MAX_CODE_CHUNK = 4000;

function chunkFile(filePath: string): { section: string; text: string }[] {
  let text: string;
  try { text = readFileSync(filePath, 'utf-8'); }
  catch { return []; }
  if (!text.trim()) return [];

  if (extname(filePath) === '.md') return chunkMarkdown(text, filePath);

  const truncated = text.length > MAX_CODE_CHUNK
    ? text.slice(0, MAX_CODE_CHUNK) + '\n...(truncated)'
    : text;
  return [{ section: basename(filePath), text: truncated }];
}

// ── Collect files ──

function collectFiles(projectRoot: string, memoryDir?: string): string[] {
  const files = new Set<string>();

  // docs/*.md
  for (const f of walkDir(join(projectRoot, 'docs'), new Set(['.md']))) files.add(f);

  // All CLAUDE.md files
  for (const f of walkDir(projectRoot, new Set(['.md']))) {
    if (basename(f) === 'CLAUDE.md') files.add(f);
  }

  // Memory
  if (memoryDir) {
    for (const f of walkDir(memoryDir, new Set(['.md']))) files.add(f);
  }

  // Core layers: full source
  for (const d of ['src/core', 'src/store', 'src/comp', 'src/server']) {
    for (const f of walkDir(join(projectRoot, d), new Set(['.ts']), /\.test\.ts$/)) files.add(f);
  }

  // Mods: types.ts, service.ts, client.ts, CLAUDE.md (CLAUDE.md already caught above)
  for (const f of walkDir(join(projectRoot, 'src/mods'), new Set(['.ts']), /\.test\.ts$/)) {
    const name = basename(f);
    if (['types.ts', 'service.ts', 'client.ts', 'server.ts', 'mcp.ts', 'view.tsx'].includes(name)) files.add(f);
  }
  // Also include .tsx views from mods
  for (const f of walkDir(join(projectRoot, 'src/mods'), new Set(['.tsx']), /\.test\.tsx$/)) {
    files.add(f);
  }

  // Frontend key files
  for (const f of ['src/front/App.tsx', 'src/front/hooks.ts', 'src/front/cache.ts', 'src/front/trpc.ts', 'src/front/Inspector.tsx']) {
    const full = join(projectRoot, f);
    if (existsSync(full)) files.add(full);
  }

  // Root config
  for (const f of ['CLAUDE.md', 'CHANGELOG.md', 'package.json']) {
    const full = join(projectRoot, f);
    if (existsSync(full)) files.add(full);
  }

  return [...files];
}

// ── Index ──

export type FileInfo = { path: string; category: DocCategory; sections: number; chars: number };

let db: DocDB | null = null;
let fileList: FileInfo[] = [];
let builtAt = 0;
let lastRoot = '';

export function buildDocIndex(projectRoot: string, memoryDir?: string): DocDB {
  if (db && lastRoot === projectRoot && Date.now() - builtAt < 60_000) return db;

  const files = collectFiles(projectRoot, memoryDir);
  const allChunks: DocChunk[] = [];
  fileList = [];

  for (const file of files) {
    const category = categorize(file, projectRoot, memoryDir);
    let mtime: number;
    try { mtime = statSync(file).mtime.getTime(); }
    catch { continue; }

    const chunks = chunkFile(file);
    const relPath = memoryDir && file.startsWith(memoryDir)
      ? 'memory/' + relative(memoryDir, file)
      : relative(projectRoot, file);

    fileList.push({ path: relPath, category, sections: chunks.length, chars: chunks.reduce((s, c) => s + c.text.length, 0) });

    for (const chunk of chunks) {
      allChunks.push({ path: relPath, section: chunk.section, category, text: chunk.text, mtime });
    }
  }

  const t0 = Date.now();
  db = create({ schema: SCHEMA });
  if (allChunks.length) insertMultiple(db, allChunks);
  builtAt = Date.now();
  lastRoot = projectRoot;
  console.log(`[doc-index] ${allChunks.length} chunks from ${files.length} files in ${Date.now() - t0}ms`);

  return db;
}

export function invalidateDocIndex() {
  db = null;
  fileList = [];
  builtAt = 0;
}

// ── Search ──

export type DocSearchResult = {
  path: string;
  section: string;
  category: string;
  snippet: string;
  score: number;
};

export async function searchDocs(opts: {
  projectRoot: string;
  memoryDir?: string;
  query: string;
  category?: DocCategory;
  pathPattern?: string;
  maxResults?: number;
  tolerance?: number;
}): Promise<DocSearchResult[]> {
  const { projectRoot, memoryDir, query, category, pathPattern, maxResults = 20, tolerance = 1 } = opts;
  const index = buildDocIndex(projectRoot, memoryDir);

  const where: Record<string, unknown> = {};
  if (category) where.category = { eq: category };

  const results = await search(index, {
    term: query,
    properties: ['text', 'section', 'path'],
    tolerance,
    where: Object.keys(where).length ? where : undefined,
    limit: maxResults * 2,  // overfetch for post-filter
  });

  let hits = results.hits;

  // Post-filter by path pattern
  if (pathPattern) {
    const re = new RegExp(pathPattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
    hits = hits.filter((h: any) => re.test(h.document.path as string));
  }

  return hits.slice(0, maxResults).map((h: any) => {
    const doc = h.document;
    return {
      path: doc.path as string,
      section: doc.section as string,
      category: doc.category as string,
      snippet: extractSnippet(doc.text as string, query, 500),
      score: h.score,
    };
  });
}

export function listDocs(projectRoot: string, memoryDir?: string, category?: DocCategory): FileInfo[] {
  buildDocIndex(projectRoot, memoryDir);
  if (category) return fileList.filter(f => f.category === category);
  return fileList;
}

export function readDoc(projectRoot: string, relPath: string, memoryDir?: string): string {
  let full = join(projectRoot, relPath);
  if (!existsSync(full) && memoryDir) {
    full = join(memoryDir, relPath.replace(/^memory\//, ''));
  }
  if (!existsSync(full)) throw new Error(`File not found: ${relPath}`);
  return readFileSync(full, 'utf-8');
}

// ── Snippet ──

function extractSnippet(text: string, query: string, maxLen: number): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const textLower = text.toLowerCase();

  let bestIdx = -1;
  for (const term of terms) {
    const idx = textLower.indexOf(term);
    if (idx !== -1) { bestIdx = idx; break; }
  }

  if (bestIdx !== -1) {
    const start = Math.max(0, bestIdx - 120);
    const end = Math.min(text.length, start + maxLen);
    return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
  }

  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}
