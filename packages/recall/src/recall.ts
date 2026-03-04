// Transcript RAG — search Claude Code session transcripts
// Orama hybrid search: BM25 full-text + vector cosine similarity (RRF fusion).
// Text index built synchronously (fast). Embeddings added in background (newest first).
// Used by: claude-search MCP mod, CLI script, mcp-transcripts

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { create, insertMultiple, search, save, load, count } from '@orama/orama';
import { embed, DIMS, MODEL, preloadEmbedder, isEmbedderReady } from '#embed';

type ContentBlock = { type: string; text?: string; thinking?: string; signature?: string };
type TranscriptMsg = {
  type: string;
  message?: { role: string; content: string | ContentBlock[] };
  sessionId?: string;
};

export type SearchResult = {
  sessionId: string;
  date: string;
  role: string;
  index: number;
  snippet: string;
  score: number;
};

export type SessionInfo = {
  id: string;
  date: string;
  messageCount: number;
  firstMessage: string;
};

// ── Compactification ──

const SKIP_TYPES = new Set(['progress', 'file-history-snapshot', 'queue-operation', 'system']);

const IDE_WRAPPERS = [
  /^<ide_opened_file>[\s\S]*?<\/ide_opened_file>\s*/,
  /^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/,
];

function stripIdeWrappers(text: string): string {
  let result = text;
  for (const re of IDE_WRAPPERS) result = result.replace(re, '');
  return result.trim();
}

function compactText(msg: TranscriptMsg): string {
  const content = msg.message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_use' || block.type === 'tool_result') continue;
    if (block.type === 'thinking' && block.thinking) {
      parts.push(block.thinking);
      continue;
    }
    if (block.type === 'text' && block.text) {
      const cleaned = msg.message!.role === 'user' ? stripIdeWrappers(block.text) : block.text;
      if (cleaned) parts.push(cleaned);
    }
  }
  return parts.join('\n');
}

// ── File helpers ──

type SessionFile = { path: string; id: string; mtime: Date; size: number };

function getSessionFiles(dir: string): SessionFile[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const p = join(dir, f);
      const st = statSync(p);
      return { path: p, id: f.replace('.jsonl', ''), mtime: st.mtime, size: st.size };
    })
    .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
}

function parseSession(path: string): TranscriptMsg[] {
  return readFileSync(path, 'utf-8').trim().split('\n').map(l => {
    try { return JSON.parse(l); }
    catch { return null; }
  }).filter(Boolean);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

const EMBED_TEXT_LIMIT = 2000;

// ── Two-phase schema: text-only (fast) then with embeddings ──

// Phase 1: text-only index for instant BM25 search
const textSchema = {
  text: 'string',
  role: 'enum',
  sessionId: 'enum',
  sessionMtime: 'number',
  msgIndex: 'number',
} as const;

// Phase 2: full index with embeddings for hybrid search
const hybridSchema = {
  text: 'string',
  role: 'enum',
  sessionId: 'enum',
  sessionMtime: 'number',
  msgIndex: 'number',
  embedding: `vector[${DIMS}]`,
} as const;

type TextDB = ReturnType<typeof create<typeof textSchema>>;
type HybridDB = ReturnType<typeof create<typeof hybridSchema>>;
type DocRow = { text: string; role: string; sessionId: string; sessionMtime: number; msgIndex: number };

// ── Persistence (hybrid index only) ──

type IndexMeta = {
  version: number;
  dims: number;
  model?: string; // embedding model name — invalidate on change
  sessions: Record<string, number>; // sessionId → file size
};

function metaPath(dir: string) { return join(dir, '.transcript-meta.json'); }
function indexPath(dir: string) { return join(dir, '.transcript-index.json'); }
function lockPath(dir: string) { return join(dir, '.transcript-embed.lock'); }

function loadMeta(dir: string): IndexMeta | null {
  try { return JSON.parse(readFileSync(metaPath(dir), 'utf-8')); }
  catch { return null; }
}

function saveMeta(dir: string, meta: IndexMeta) {
  writeFileSync(metaPath(dir), JSON.stringify(meta));
}

function loadPersistedIndex(dir: string): HybridDB | null {
  try {
    const raw = readFileSync(indexPath(dir), 'utf-8');
    const db = create({ schema: hybridSchema });
    load(db, JSON.parse(raw));
    return db;
  } catch { return null; }
}

function persistIndex(dir: string, db: HybridDB) {
  try { writeFileSync(indexPath(dir), JSON.stringify(save(db))); }
  catch (e: any) { console.error('[transcripts] persist failed:', e.message); }
}

// ── Embedding lock (file-based, PID) ──
// Prevents multiple mcp-transcripts instances from embedding concurrently.

import { unlinkSync } from 'node:fs';

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireEmbedLock(dir: string): boolean {
  const lp = lockPath(dir);
  try {
    const raw = readFileSync(lp, 'utf-8');
    const pid = parseInt(raw, 10);
    if (pid && isProcessAlive(pid)) return false; // another instance is embedding
    // Stale lock — owner dead
    unlinkSync(lp);
  } catch { /* no lock file */ }

  try {
    writeFileSync(lp, String(process.pid), { flag: 'wx' }); // exclusive create
    return true;
  } catch {
    return false; // race — another instance grabbed it
  }
}

function releaseEmbedLock(dir: string) {
  try {
    const raw = readFileSync(lockPath(dir), 'utf-8');
    if (parseInt(raw, 10) === process.pid) unlinkSync(lockPath(dir));
  } catch { /* already gone */ }
}

// ── Index state ──

type IndexState = {
  textDB: TextDB;              // always available, BM25-only
  hybridDB: HybridDB | null;  // available after embeddings are done
  dir: string;
  meta: IndexMeta;
  builtAt: number;
  embeddingInProgress: boolean;
  embeddedSessions: number;
  totalSessions: number;
};

let state: IndexState | null = null;
let embedPromise: Promise<void> | null = null;

/** Extract docs from session files. */
function extractAllDocs(files: SessionFile[]): DocRow[] {
  const allDocs: DocRow[] = [];

  for (const file of files) {
    const msgs = parseSession(file.path);

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (SKIP_TYPES.has(m.type)) continue;
      if (m.type !== 'user' && m.type !== 'assistant') continue;

      const text = compactText(m);
      if (!text) continue;

      allDocs.push({
        text,
        role: m.message?.role || m.type,
        sessionId: file.id,
        sessionMtime: file.mtime.getTime(),
        msgIndex: i,
      });
    }
  }

  return allDocs;
}

/** Exclude the most recent session if it was modified < 30s ago (likely the active session). */
function excludeActiveSession(files: SessionFile[]): SessionFile[] {
  if (!files.length) return files;
  const newest = files[files.length - 1];
  if (Date.now() - newest.mtime.getTime() < 30_000) return files.slice(0, -1);
  return files;
}

/** Phase 1: Build text-only index synchronously. Instant. */
function buildTextIndex(files: SessionFile[]): TextDB {
  const t0 = Date.now();
  const db = create({ schema: textSchema });
  const safe = excludeActiveSession(files);
  const docs = extractAllDocs(safe);
  if (docs.length) insertMultiple(db, docs);
  console.log(`[transcripts] text index: ${docs.length} docs from ${safe.length} sessions in ${Date.now() - t0}ms`);
  return db;
}

/** Phase 2: Build hybrid index with embeddings in background. Only embeds NEW/CHANGED sessions. */
function startEmbeddingBackground(dir: string, files: SessionFile[]) {
  if (embedPromise || !state) return;

  // Check if we have a persisted hybrid index
  const meta = loadMeta(dir);
  const persisted = meta ? loadPersistedIndex(dir) : null;

  if (persisted && meta && meta.model === MODEL) {
    // Always load persisted as base — even if some sessions changed
    state.hybridDB = persisted;
    state.meta = meta;

    // Find only new/changed sessions (delta)
    const safe = excludeActiveSession(files);
    const delta = safe.filter(f => meta.sessions[f.id] !== f.size);

    if (!delta.length) {
      state.embeddedSessions = files.length;
      console.log(`[transcripts] loaded persisted hybrid index (${count(persisted)} docs, all up to date)`);
      return;
    }

    // Incremental: embed only delta, append to persisted index
    if (!acquireEmbedLock(dir)) {
      console.log(`[transcripts] another instance is embedding, skipping`);
      return;
    }
    console.log(`[transcripts] loaded persisted index, ${delta.length} sessions need update`);
    startDeltaEmbedding(dir, persisted, meta, delta);
    return;
  }

  // No persisted index — full build
  if (!acquireEmbedLock(dir)) {
    console.log(`[transcripts] another instance is embedding, skipping`);
    return;
  }
  startFullEmbedding(dir, files);
}

/** Embed only changed/new sessions, append to existing hybrid index. */
function startDeltaEmbedding(dir: string, hybridDB: HybridDB, meta: IndexMeta, delta: SessionFile[]) {
  if (!state) return;

  preloadEmbedder();
  state.embeddingInProgress = true;

  embedPromise = (async () => {
    if (!state) return;

    // Newest first for better progressive search
    const toEmbed = [...delta].reverse();
    console.log(`[transcripts] incremental: embedding ${toEmbed.length} sessions...`);

    for (const file of toEmbed) {
      if (!state) break;

      const docs = extractAllDocs([file]);
      if (!docs.length) {
        meta.sessions[file.id] = file.size;
        continue;
      }

      try {
        const texts = docs.map(d => truncate(d.text, EMBED_TEXT_LIMIT));
        const embeddings: number[][] = [];
        for (let i = 0; i < texts.length; i += 16) {
          const vecs = await embed(texts.slice(i, i + 16));
          embeddings.push(...vecs);
        }
        insertMultiple(hybridDB, docs.map((d, i) => ({ ...d, embedding: embeddings[i] })));
      } catch (e: any) {
        console.warn(`[transcripts] embed failed for ${file.id.slice(0, 8)}:`, e.message);
        const zeroVec = new Array(DIMS).fill(0);
        insertMultiple(hybridDB, docs.map(d => ({ ...d, embedding: zeroVec })));
      }

      meta.sessions[file.id] = file.size;
    }

    // Persist
    state.meta = meta;
    persistIndex(dir, hybridDB);
    saveMeta(dir, meta);
    state.embeddingInProgress = false;
    embedPromise = null;
    releaseEmbedLock(dir);
    console.log(`[transcripts] incremental embedding done: +${delta.length} sessions (${count(hybridDB)} total docs)`);
  })();

  embedPromise.catch(e => {
    console.error('[transcripts] incremental embedding failed:', e.message);
    if (state) state.embeddingInProgress = false;
    embedPromise = null;
    releaseEmbedLock(dir);
  });
}

/** Full embedding from scratch (no persisted index available). */
function startFullEmbedding(dir: string, files: SessionFile[]) {
  if (!state) return;

  preloadEmbedder();
  state.embeddingInProgress = true;

  embedPromise = (async () => {
    if (!state) return;

    const toEmbed = [...excludeActiveSession(files)].reverse();
    const hybridDB = create({ schema: hybridSchema });
    const sessionSizes: Record<string, number> = {};

    console.log(`[transcripts] full embedding: ${toEmbed.length} sessions (newest first)...`);

    for (const file of toEmbed) {
      if (!state) break;

      const docs = extractAllDocs([file]);
      if (!docs.length) {
        sessionSizes[file.id] = file.size;
        state.embeddedSessions++;
        continue;
      }

      try {
        const texts = docs.map(d => truncate(d.text, EMBED_TEXT_LIMIT));
        const embeddings: number[][] = [];
        for (let i = 0; i < texts.length; i += 16) {
          const vecs = await embed(texts.slice(i, i + 16));
          embeddings.push(...vecs);
        }
        insertMultiple(hybridDB, docs.map((d, i) => ({ ...d, embedding: embeddings[i] })));
      } catch (e: any) {
        console.warn(`[transcripts] embed failed for ${file.id.slice(0, 8)}:`, e.message);
        const zeroVec = new Array(DIMS).fill(0);
        insertMultiple(hybridDB, docs.map(d => ({ ...d, embedding: zeroVec })));
      }

      sessionSizes[file.id] = file.size;
      state.embeddedSessions++;
      state.hybridDB = hybridDB;

      if (state.embeddedSessions % 10 === 0) {
        state.meta.sessions = { ...sessionSizes };
        persistIndex(dir, hybridDB);
        saveMeta(dir, state.meta);
      }
    }

    state.meta.sessions = { ...sessionSizes };
    persistIndex(dir, hybridDB);
    saveMeta(dir, state.meta);
    state.embeddingInProgress = false;
    embedPromise = null;
    releaseEmbedLock(dir);
    console.log(`[transcripts] full embedding complete: ${count(hybridDB)} docs`);
  })();

  embedPromise.catch(e => {
    console.error('[transcripts] full embedding failed:', e.message);
    if (state) state.embeddingInProgress = false;
    embedPromise = null;
    releaseEmbedLock(dir);
  });
}

/** Get text-only index (always available) and kick off embeddings. */
function ensureIndex(dir: string): TextDB {
  const files = getSessionFiles(dir);
  const maxMtime = files.length ? Math.max(...files.map(f => f.mtime.getTime())) : 0;

  // Cache hit — allow 60s grace period to avoid constant rebuilds during active session
  if (state && state.dir === dir && (maxMtime <= state.builtAt || Date.now() - state.builtAt < 60_000)) {
    return state.textDB;
  }

  // Rebuild text index (fast, ~5s) but PRESERVE hybrid state if embedding is running
  const textDB = buildTextIndex(files);

  if (state && state.dir === dir) {
    // Just update text index, keep hybrid DB + embedding background intact
    state.textDB = textDB;
    state.builtAt = Date.now();
    state.totalSessions = files.length;
  } else {
    // First init
    state = {
      textDB,
      hybridDB: null,
      dir,
      meta: { version: 1, dims: DIMS, model: MODEL, sessions: {} },
      builtAt: Date.now(),
      embeddingInProgress: false,
      embeddedSessions: 0,
      totalSessions: files.length,
    };
    startEmbeddingBackground(dir, files);
  }

  return textDB;
}

/** Force re-index. */
export function invalidateIndex() {
  state = null;
  embedPromise = null;
}

// ── Snippet extraction ──

function extractSnippet(text: string, query: string, maxLen: number): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const textLower = text.toLowerCase();

  let bestIdx = -1;
  for (const term of terms) {
    const idx = textLower.indexOf(term);
    if (idx !== -1) { bestIdx = idx; break; }
  }

  if (bestIdx !== -1) {
    const start = Math.max(0, bestIdx - 100);
    const end = Math.min(text.length, start + maxLen);
    return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
  }

  return truncate(text, maxLen);
}

// ── Auto-detect transcript dir ──

export function findTranscriptsDir(cwd?: string): string {
  const target = (cwd ?? process.cwd()).replace(/\//g, '-').replace(/^-/, '-');
  const base = join(homedir(), '.claude/projects');
  const candidates = readdirSync(base).filter(d => d.startsWith(target.slice(0, 20)));

  const exact = candidates.find(d => d === target);
  if (exact) return join(base, exact);
  if (candidates.length) return join(base, candidates.sort((a, b) => b.length - a.length)[0]);

  throw new Error(`No transcript dir found for CWD: ${cwd ?? process.cwd()}`);
}

// ── Public API ──

/** Search transcripts. Uses hybrid (BM25+vector) if embeddings ready, text-only otherwise. */
export async function searchTranscripts(opts: {
  dir: string;
  query: string;
  role?: 'user' | 'assistant';
  lastN?: number;
  maxResults?: number;
  snippetLength?: number;
  tolerance?: number;
}): Promise<SearchResult[]> {
  const { dir, query, role, lastN = 50, maxResults = 20, snippetLength = 400, tolerance = 1 } = opts;
  ensureIndex(dir); // always builds text index + kicks off embeddings

  // Build where clause
  const where: Record<string, unknown> = {};
  if (role) where.role = { eq: role };
  if (lastN) {
    const files = getSessionFiles(dir);
    const cutoffIdx = Math.max(0, files.length - lastN);
    if (cutoffIdx > 0) where.sessionMtime = { gte: files[cutoffIdx].mtime.getTime() };
  }

  const whereClause = Object.keys(where).length ? where : undefined;

  // Use hybrid only when full index is ready (all sessions embedded).
  // During background indexing, text-only BM25 searches ALL sessions — better coverage.
  // Once done, hybrid (BM25 + vector) is available via persisted index.
  const hybridDB = state?.hybridDB;
  const indexReady = state && !state.embeddingInProgress;
  if (hybridDB && indexReady && isEmbedderReady()) {
    try {
      const vecs = await embed([query], true);
      const results = await search(hybridDB, {
        mode: 'hybrid',
        term: query,
        properties: ['text'],
        vector: { value: vecs[0], property: 'embedding' },
        similarity: 0.2,
        tolerance,
        where: whereClause,
        limit: maxResults,
      } as any);

      if (results.hits.length) {
        return results.hits.map((hit: any) => {
          const doc = hit.document;
          return {
            sessionId: doc.sessionId as string,
            date: new Date(doc.sessionMtime as number).toISOString().slice(0, 16),
            role: doc.role as string,
            index: doc.msgIndex as number,
            snippet: extractSnippet(doc.text as string, query, snippetLength),
            score: hit.score,
          };
        });
      }
      // Hybrid returned nothing (index incomplete) — fall through to text-only
    } catch {
      // Fall through to text-only
    }
  }

  // Fallback: text-only BM25 search
  const textDB = state!.textDB;
  const results = await search(textDB, {
    term: query,
    properties: ['text'],
    tolerance,
    where: whereClause,
    limit: maxResults,
  });

  return results.hits.map((hit: any) => {
    const doc = hit.document;
    return {
      sessionId: doc.sessionId as string,
      date: new Date(doc.sessionMtime as number).toISOString().slice(0, 16),
      role: doc.role as string,
      index: doc.msgIndex as number,
      snippet: extractSnippet(doc.text as string, query, snippetLength),
      score: hit.score,
    };
  });
}

/** List recent sessions with summary info. */
export function listSessions(dir: string, lastN = 30): SessionInfo[] {
  const sessions = getSessionFiles(dir).slice(-lastN);

  return sessions.map(s => {
    const msgs = parseSession(s.path);
    const userMsgs = msgs.filter(m => m.type === 'user');
    const allMsgs = msgs.filter(m => !SKIP_TYPES.has(m.type) && (m.type === 'user' || m.type === 'assistant'));
    const first = userMsgs[0] ? truncate(compactText(userMsgs[0]), 120) : '(empty)';

    return {
      id: s.id,
      date: s.mtime.toISOString().slice(0, 16),
      messageCount: allMsgs.length,
      firstMessage: first,
    };
  });
}

export type ReadSessionOpts = {
  role?: 'user' | 'assistant';
  maxLength?: number;
  /** Only include messages containing this text (case-insensitive) */
  grep?: string;
  /** Start from message index (0-based, after role filter) */
  offset?: number;
  /** Max number of messages to return */
  limit?: number;
  /** Read messages newest-first */
  reverse?: boolean;
  /** Truncate each message to N chars */
  msgMaxLength?: number;
  /** Include message index numbers in output */
  showIndex?: boolean;
};

/** Get compact text of a session. */
export function getSessionText(dir: string, sessionPrefix: string, opts?: ReadSessionOpts): string {
  const sessions = getSessionFiles(dir);
  const session = sessions.find(s => s.id.startsWith(sessionPrefix));
  if (!session) return `Session not found: ${sessionPrefix}`;

  const msgs = parseSession(session.path);
  const maxLen = opts?.maxLength ?? 15000;
  const grepLower = opts?.grep?.toLowerCase();

  // Collect matching messages with their original indices
  type Msg = { role: string; content: string; index: number };
  const filtered: Msg[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (SKIP_TYPES.has(m.type)) continue;
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    if (opts?.role && m.message?.role !== opts.role) continue;

    const content = compactText(m);
    if (!content) continue;
    if (grepLower && !content.toLowerCase().includes(grepLower)) continue;

    filtered.push({ role: m.message?.role || m.type, content, index: i });
  }

  if (opts?.reverse) filtered.reverse();

  // Apply offset/limit
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? Infinity;
  const sliced = filtered.slice(offset, offset + limit);

  // Build output
  let text = '';
  const msgMax = opts?.msgMaxLength;

  for (const msg of sliced) {
    const content = msgMax ? truncate(msg.content, msgMax) : msg.content;
    const prefix = opts?.showIndex ? `[${msg.index}:${msg.role}]` : `[${msg.role}]`;
    text += `${prefix} ${content}\n\n`;

    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + '\n...(truncated)';
      break;
    }
  }

  if (!text && filtered.length) {
    return `(${filtered.length} messages matched but offset/limit excluded all)`;
  }

  return text || '(no matching messages)';
}
