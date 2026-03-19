// Metatron — Claude Agent SDK wrapper
// Uses v1 query() API — simpler, more robust than unstable_v2 sessions
// Sessions persist via `resume` option. If resume fails, auto-retries fresh.
// Active query registry: keyed by configPath, enables abort from stop action.

import { type CanUseTool, query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { evaluatePermission, type PermissionRule } from './permissions';

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export type ClaudeResult = {
  output: string;   // full log: text + tool calls + thinking + results
  text: string;     // clean text only (assistant text blocks)
  sessionId?: string;
  durationMs: number;
  costUsd?: number;
  error?: boolean;
  aborted?: boolean;
};

export type ClaudeStreamCallback = (chunk: string) => void;

const log = (msg: string) => console.log(`[metatron:claude] ${msg}`);

// ── Active query registry ──

type ActiveEntry = { query: Query; ac: AbortController };
const activeQueries = new Map<string, ActiveEntry>();

/** Abort a running query by key (config path). Returns true if aborted. */
export function abortQuery(key: string): boolean {
  const entry = activeQueries.get(key);
  if (!entry) return false;
  log(`aborting query: ${key}`);
  entry.ac.abort();
  entry.query.close();
  return true;
}

/** Check if a query is currently running for the given key */
export function isQueryRunning(key: string): boolean {
  return activeQueries.has(key);
}

// Extract readable text from tool_result content.
// MCP tools return {content: [{type:"text", text:"already formatted string"}]}.
// We extract .text from each block instead of JSON.stringify'ing the whole array.
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      return JSON.stringify(b);
    }).join('\n');
  }
  return String(content);
}

const DEFAULT_TOOLS = [
  'mcp__treenity__get_node',
  'mcp__treenity__list_children',
  'mcp__treenity__set_node',
  'mcp__treenity__remove_node',
  'mcp__treenity__execute',
  'mcp__treenity__deploy_prefab',
  'mcp__treenity__compile_view',
  'mcp__treenity__catalog',
  'mcp__treenity__describe_type',
  'mcp__treenity__search_types',
];

function applyPermissionRules(rules: PermissionRule[]): { allowed: string[]; denied: string[] } {
  if (!rules.length) return { allowed: DEFAULT_TOOLS, denied: [] };

  const allowed: string[] = [];
  const denied: string[] = [];

  for (const tool of DEFAULT_TOOLS) {
    const policy = evaluatePermission(rules, tool, {});
    if (policy === 'deny') {
      denied.push(tool);
      log(`  permission: DENY ${tool}`);
    } else {
      allowed.push(tool);
    }
  }

  return { allowed, denied };
}

async function runQuery(
  prompt: string,
  opts: {
    key?: string;
    sessionId?: string;
    forkSession?: boolean;
    model?: string;
    mcpUrl?: string;
    abortController?: AbortController;
    permissionRules?: PermissionRule[];
    canUseTool?: CanUseTool;
    onOutput?: ClaudeStreamCallback;
  },
): Promise<ClaudeResult> {
  const mcpUrl = opts.mcpUrl || process.env.TREENITY_MCP_URL || 'http://localhost:3212/mcp';
  const startTime = Date.now();

  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let isError = false;

  const ac = opts.abortController ?? new AbortController();
  const { allowed, denied } = applyPermissionRules(opts.permissionRules ?? []);

  // Array accumulation avoids O(n^2) string concatenation
  const outputChunks: string[] = [];
  const textChunks: string[] = [];

  const stream = query({
    prompt,
    options: {
      ...(opts.sessionId ? { resume: opts.sessionId } : {}),
      ...(opts.forkSession ? { forkSession: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      abortController: ac,
      permissionMode: opts.canUseTool ? 'bypassPermissions' : 'default',
      ...(opts.canUseTool ? { allowDangerouslySkipPermissions: true } : {}),
      allowedTools: allowed,
      ...(denied.length ? { disallowedTools: denied } : {}),
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
      mcpServers: {
        treenity: { type: 'http', url: mcpUrl },
      },
    },
  });

  // Register in active queries map
  if (opts.key) activeQueries.set(opts.key, { query: stream, ac });

  const append = (text: string) => {
    outputChunks.push(text);
    opts.onOutput?.(text);
  };

  try {
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = (message as any).session_id;
        log(`  session: ${sessionId}`);
      }

      const msg = message as any;

      if (message.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            textChunks.push(block.text);
            append(block.text);
          } else if (block.type === 'tool_use') {
            log(`  tool: ${block.name} ${JSON.stringify(block.input)}`);
            const input = JSON.stringify(block.input, null, 2);
            append(`\n[tool ${ts()}] ${block.name}\n${input}\n`);
          } else if (block.type === 'thinking' && block.thinking) {
            append(`\n[thinking ${ts()}]\n${block.thinking}\n`);
          }
        }
      }

      // tool results come as user messages with tool_result blocks
      if (message.type === 'user' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            const content = extractToolResultText(block.content);
            append(`\n[result ${ts()}] ${content}\n`);
          }
        }
      }

      if (message.type === 'result') {
        sessionId = msg.session_id ?? sessionId;
        costUsd = msg.cost_usd;
        isError = msg.is_error ?? false;
      }
    }
  } catch (err) {
    // AbortError = user-initiated stop, not a failure
    if (ac.signal.aborted) {
      append(`\n[interrupted ${ts()}]\n`);
      return {
        output: outputChunks.join(''),
        text: textChunks.join(''),
        sessionId,
        durationMs: Date.now() - startTime,
        costUsd,
        aborted: true,
      };
    }
    throw err;
  } finally {
    if (opts.key) activeQueries.delete(opts.key);
  }

  return {
    output: outputChunks.join(''),
    text: textChunks.join(''),
    sessionId,
    durationMs: Date.now() - startTime,
    costUsd,
    error: isError,
  };
}

export async function invokeClaude(
  prompt: string,
  opts: {
    key?: string;
    sessionId?: string;
    forkSession?: boolean;
    model?: string;
    mcpUrl?: string;
    abortController?: AbortController;
    permissionRules?: PermissionRule[];
    canUseTool?: CanUseTool;
    onOutput?: ClaudeStreamCallback;
  } = {},
): Promise<ClaudeResult> {
  const promptPreview = prompt.length > 120 ? prompt.slice(0, 120) + '...' : prompt;
  log(`query: "${promptPreview}" session=${opts.sessionId?.slice(0, 8) ?? 'new'}`);

  try {
    return await runQuery(prompt, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  FAILED: ${msg}`);

    // If resuming a session failed, retry without session (fresh start)
    if (opts.sessionId) {
      log(`  retrying without session...`);
      try {
        return await runQuery(prompt, { ...opts, sessionId: undefined });
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`  retry also FAILED: ${retryMsg}`);
        throw retryErr;
      }
    }

    throw err;
  }
}

/** Close a running session — no-op since queries self-clean via AbortController */
export function closeSession(_key: string) {
  abortQuery(_key);
}
