// Treenix MCP Server — exposes tree store as MCP tools
// StreamableHTTP transport, stateful sessions, token auth via Authorization: Bearer header

import { rememberRule, requestApproval, resolveVerdict } from '#agent/guardian';
import { AiPolicy } from '#agent/types';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createNode, getComponent } from '@treenx/core';
import { matchesAny } from '@treenx/core/glob';
import { verifyViewSource } from '@treenx/core/mods/uix/verify';
import { TypeCatalog } from '@treenx/core/schema/catalog';
import { executeAction } from '@treenx/core/server/actions';
import { buildClaims, resolveToken, type Session, withAcl } from '@treenx/core/server/auth';
import { deployPrefab } from '@treenx/core/server/prefab';
import type { Tree } from '@treenx/core/tree';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod/v3';


// Guardian policy check for MCP operations
// Full structured context: tool + all args. Glob matching on compound subjects.
// Evaluation: deny (any level) → allow/escalate (most specific wins) → deny-by-default
export type McpGuardianResult =
  | { allowed: true }
  | { allowed: false; reason: string }
  | { allowed: 'prompt'; subjects: string[]; args: Record<string, unknown> };

// Guardian receives the complete MCP call — tool name + all arguments
export type GuardianRequest = {
  tool: string;                    // MCP tool: 'execute', 'set_node', 'remove_node', etc.
  args: Record<string, unknown>;   // full args as passed to the MCP tool handler
};

// Build glob subjects from request: most specific → least specific
// Extracts action + target path from args (handles path, target, source)
export function buildSubjects(req: GuardianRequest): string[] {
  const base = `mcp__treenix__${req.tool}`;
  const subjects: string[] = [];

  const action = typeof req.args?.action === 'string' && req.args.action ? req.args.action : null;
  const target = typeof req.args?.path === 'string' && req.args.path ? req.args.path
    : typeof req.args?.target === 'string' && req.args.target ? req.args.target : null;

  if (action && target) subjects.push(`${base}:${action}:${target}`);
  if (action) subjects.push(`${base}:${action}`);
  if (!action && target) subjects.push(`${base}:${target}`);
  subjects.push(base);

  return subjects;
}

export async function checkMcpGuardian(store: Tree, req: GuardianRequest): Promise<McpGuardianResult> {
  try {
    const guardianNode = await store.get('/guardian');
    if (!guardianNode) return { allowed: false, reason: 'no Guardian configured at /guardian — all writes denied' };

    const policy = getComponent(guardianNode, AiPolicy);
    if (!policy || policy.$type !== 'ai.policy') return { allowed: false, reason: 'invalid Guardian policy type — writes denied' };

    const policyData = {
      allow: (policy.allow as string[]) ?? [],
      deny: (policy.deny as string[]) ?? [],
      escalate: (policy.escalate as string[]) ?? [],
    };
    const subjects = buildSubjects(req);

    // Shared specificity-aware resolution (same as agent guardian)
    const verdict = resolveVerdict(policyData, subjects);

    if (verdict === 'deny') {
      const denied = subjects.find(s => matchesAny(policyData.deny, s)) ?? subjects[0];
      return { allowed: false, reason: `denied by Guardian: ${denied}` };
    }
    if (verdict === 'allow') return { allowed: true };
    // escalate or unknown → prompt human
    return { allowed: 'prompt', subjects, args: req.args };
  } catch (err) {
    console.error('[mcp-guardian] policy check failed:', err);
    return { allowed: false, reason: 'Guardian check failed — writes denied for safety' };
  }
}

/** Compact YAML-like serializer — readable for LLMs, much less noisy than JSON */
function yaml(val: unknown, depth = 0, maxStr = 300): string {
  const pad = '  '.repeat(depth);
  if (val == null) return 'null';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    if (maxStr < Infinity && val.length > maxStr) return JSON.stringify(val.slice(0, maxStr) + '…');
    return /[\n\r:#\[\]{}",]/.test(val) || val === '' ? JSON.stringify(val) : val;
  }
  if (Array.isArray(val)) {
    if (!val.length) return '[]';
    if (val.every(v => typeof v !== 'object' || v == null)) {
      const inline = `[${val.map(v => yaml(v, 0, maxStr)).join(', ')}]`;
      if (inline.length < 80) return inline;
    }
    return val.map(item => {
      if (typeof item !== 'object' || item == null) return `${pad}- ${yaml(item, 0, maxStr)}`;
      const inner = yaml(item, depth + 1, maxStr);
      const lines = inner.split('\n');
      return lines.length === 1
        ? `${pad}- ${lines[0].trimStart()}`
        : `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).map(l => `${pad}  ${l.trimStart()}`).join('\n')}`;
    }).join('\n');
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    if (!entries.length) return '{}';
    return entries.map(([k, v]) => {
      if (v != null && typeof v === 'object') {
        const inner = yaml(v, depth + 1, maxStr);
        if (!inner.includes('\n') && inner.length < 60) return `${pad}${k}: ${inner.trimStart()}`;
        return `${pad}${k}:\n${inner}`;
      }
      return `${pad}${k}: ${yaml(v, 0, maxStr)}`;
    }).join('\n');
  }
  return String(val);
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** Build human-friendly label from subject pattern */
function subjectLabel(subject: string): string {
  // mcp__treenix__execute:add:/board → "execute:add on /board"
  const short = subject.replace('mcp__treenix__', '');
  const parts = short.split(':');
  if (parts.length === 3) return `${parts[0]}:${parts[1]} on ${parts[2]}`;
  if (parts.length === 2) return `all ${parts[1]} actions via ${parts[0]}`;
  return `all ${parts[0]} calls`;
}

/** Check guardian and block until human approves.
 * Two modes: inline elicitation (clients that support it — Claude Code, etc.)
 * vs tree-based approval node (agents, headless, batch). Selection by client capability. */
async function guardBlock(
  guard: McpGuardianResult,
  store: Tree,
  userId: string,
  mcp: McpServer,
) {
  if (guard.allowed === true) return null;
  if (guard.allowed === false) return text(`🛑 Guardian: ${guard.reason}`);

  const tool = guard.subjects[0] ?? 'unknown';
  const label = subjectLabel(tool);
  const argPreview = yaml(guard.args, 0, 200);

  if (mcp.server.getClientCapabilities()?.elicitation) {
    try {
      const narrow = guard.subjects[0] ?? tool;
      const broad = guard.subjects.at(-1) ?? tool;
      const result = await mcp.server.elicitInput({
        message: `Guardian approval required\n\n${label}\n\n${argPreview}`,
        requestedSchema: {
          type: 'object',
          properties: {
            remember: {
              type: 'string',
              title: 'Remember decision',
              description: 'Persist the chosen action (accept→allow, decline→deny) into /guardian policy',
              enum: ['once', 'this-path', 'this-tool'],
              enumNames: [
                'Just this once',
                `Always for ${narrow.replace('mcp__treenix__', '')}`,
                `Always for ${broad.replace('mcp__treenix__', '')}`,
              ],
              default: 'once',
            },
          },
        },
      });

      if (result.action !== 'accept' && result.action !== 'decline') {
        return text(`🛑 Guardian: ${result.action} by user`);
      }

      const remember = (result.content?.remember as string | undefined) ?? 'once';
      const allow = result.action === 'accept';

      if (remember !== 'once') {
        const subject = remember === 'this-tool' ? broad : narrow;
        try {
          await rememberRule(store, subject, JSON.stringify(guard.args), allow, '', 'global');
        } catch (err) {
          console.error('[mcp-guardian] failed to persist rule:', err);
        }
      }

      return allow ? null : text(`🛑 Guardian: declined by user`);
    } catch (err) {
      console.error('[mcp-guardian] elicitInput failed, falling back to tree approval:', err);
    }
  }

  const approved = await requestApproval(store, {
    agentPath: `/agents/mcp:${userId}`,
    role: 'mcp',
    tool,
    input: JSON.stringify(guard.args),
    reason: `MCP escalation: ${label}`,
  });
  return approved ? null : text(`🛑 Guardian: denied by human`);
}

const catalog = new TypeCatalog();

function dataKeys(node: Record<string, unknown>) {
  return Object.keys(node).filter(k => !k.startsWith('$'));
}

export async function buildMcpServer(store: Tree, session: Session, claims?: string[]) {
  claims ??= session.claims ?? await buildClaims(store, session.userId);
  const root = await store.get('/');
  console.log(`[mcp-diag] userId=${session.userId}, claims=[${claims}], root.$acl=${JSON.stringify(root?.$acl)}`);
  const aclStore = withAcl(store, session.userId, claims);

  const mcp = new McpServer({ name: 'treenix', version: '1.0.0' });

  /** Check guardian policy; block on escalation until human approves */
  async function guarded(tool: string, args: Record<string, unknown>) {
    const guard = await checkMcpGuardian(store, { tool, args });
    return guardBlock(guard, store, session.userId, mcp);
  }

  mcp.registerTool(
    'get_node',
    {
      description: 'Read a node by path. Returns full untruncated values.',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const node = await aclStore.get(path);
      return text(node ? yaml(node, 0, Infinity) : `not found: ${path}`);
    },
  );

  mcp.registerTool(
    'list_children',
    {
      description: 'List children of a node. Long string values may be truncated — use get_node for full data.',
      inputSchema: {
        path: z.string(),
        depth: z.number().optional(),
        detail: z.boolean().optional().describe('Show first-level fields and component types'),
        full: z.boolean().optional().describe('Return complete YAML of each node'),
      },
    },
    async ({ path, depth, detail, full }) => {
      const ctx = { queryContextPath: path, userId: session.userId };
      const result = await aclStore.getChildren(path, { depth }, ctx);
      const { items, total, truncated } = result;
      const truncNote = truncated ? '\n⚠️ Results truncated — ACL scan limit reached. Use query mounts for large collections.' : '';

      if (full) return text(yaml({ total, truncated, items }));

      if (detail) {
        const lines = items.map(n => {
          const name = n.$path.split('/').at(-1);
          const keys = dataKeys(n);
          const header = n.$type === 'dir' ? `${name}/` : `${name}: ${n.$type}  [${keys.length}]`;
          const fields = keys.map(k => {
            const v = (n as Record<string, unknown>)[k];
            if (v && typeof v === 'object' && '$type' in (v as object))
              return `  ${k}: ${(v as Record<string, unknown>).$type}`;
            if (Array.isArray(v)) return `  ${k}: [${v.length}]`;
            const s = String(v);
            return `  ${k}: ${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
          });
          return header + (fields.length ? '\n' + fields.join('\n') : '');
        });
        return text(lines.join('\n') + `\n(${total} total)` + truncNote);
      }

      const lines = items.map(n => {
        const name = n.$path.split('/').at(-1);
        if (n.$type === 'dir') return `${name}/`;
        return `${name}  ${n.$type}  [${dataKeys(n).length}]`;
      });
      return text(lines.join('\n') + (total > items.length ? `\n(${total} total)` : '') + truncNote);
    },
  );

  mcp.registerTool(
    'set_node',
    {
      description: 'Create or update a node. May require Guardian approval.',
      inputSchema: {
        path: z.string(),
        type: z.string(),
        components: z.record(z.unknown()).optional(),
        acl: z.array(z.object({ g: z.string(), p: z.number() })).optional(),
        owner: z.string().optional(),
      },
    },
    async ({ path, type, components, acl, owner }) => {
      const blocked = await guarded('set_node', { path, type, components, acl, owner });
      if (blocked) return blocked;
      const existing = await aclStore.get(path);
      const node = existing ?? createNode(path, type);
      if (!existing) node.$type = type;
      if (components) {
        for (const [k, v] of Object.entries(components)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          const comp = v as Record<string, unknown> | null;
          if (comp && typeof comp === 'object' && comp.$type === type) {
            for (const [fk, fv] of Object.entries(comp)) {
              if (fk !== '$type') node[fk] = fv;
            }
            continue;
          }
          node[k] = v;
        }
      }
      if (acl) node.$acl = acl;
      if (owner) node.$owner = owner;
      await aclStore.set(node);
      return text(yaml(node));
    },
  );

  mcp.registerTool(
    'execute',
    {
      description: 'Execute an action on a node or component. Actions are methods registered on types. May require Guardian approval.',
      inputSchema: {
        path: z.string(),
        action: z.string(),
        type: z.string().optional(),
        key: z.string().optional(),
        data: z.record(z.unknown()).optional(),
      },
    },
    async ({ path, action, type, key, data }) => {
      const blocked = await guarded('execute', { path, action, type, key, data });
      if (blocked) return blocked;
      const result = await executeAction(aclStore, path, type, key, action, data);
      return text(yaml(result ?? { ok: true }));
    },
  );

  mcp.registerTool(
    'deploy_prefab',
    {
      description: 'Deploy a module prefab (node tree template) to a target path. Idempotent: skips existing nodes. Browse available prefabs via list_children /sys/mods.',
      inputSchema: {
        source: z.string().describe('Prefab path: /sys/mods/{mod}/prefabs/{name}'),
        target: z.string().describe('Target path where nodes will be created'),
        allowAbsolute: z.boolean().optional().describe('Allow prefab to write outside target (e.g. /sys/autostart refs). Default: false'),
      },
    },
    async ({ source, target, allowAbsolute }) => {
      const blocked = await guarded('deploy_prefab', { source, target, allowAbsolute });
      if (blocked) return blocked;
      const result = await deployPrefab(aclStore, source, target, { allowAbsolute });
      return text(yaml(result));
    },
  );

  mcp.registerTool(
    'compile_view',
    {
      description: 'Verify that a UIX view source compiles correctly. Pass path to check an existing type node, or source to verify before writing.',
      inputSchema: {
        path: z.string().optional().describe('Path to type node (e.g. /sys/types/cosmos/system) — reads view.source'),
        source: z.string().optional().describe('Raw JSX/TSX source to verify directly'),
      },
    },
    async ({ path, source }) => {
      let code = source;
      if (!code) {
        if (!path) return text('error: provide path or source');
        const node = await aclStore.get(path);
        if (!node) return text(`not found: ${path}`);
        code = (node as any)?.view?.source;
        if (!code || typeof code !== 'string') return text(`no view.source on ${path}`);
      }
      const result = verifyViewSource(code);
      return text(yaml(result));
    },
  );

  mcp.registerTool(
    'remove_node',
    {
      description: 'Remove a node by path. May be denied by Guardian.',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const blocked = await guarded('remove_node', { path });
      if (blocked) return blocked;
      const ok = await aclStore.remove(path);
      return text(ok ? `removed: ${path}` : `not found: ${path}`);
    },
  );

  // ── Discovery tools — powered by TypeCatalog ──

  mcp.registerTool(
    'catalog',
    {
      description: 'List all registered types with compact descriptions plus property/action docs. Use this first to discover what types exist.',
      inputSchema: {},
    },
    async () => text(yaml(catalog.list())),
  );

  mcp.registerTool(
    'describe_type',
    {
      description: 'Get full schema of a type: properties, actions with argument types, and cross-references to other types. Use after catalog to understand a specific type deeply.',
      inputSchema: { type: z.string().describe('Type name, e.g. "cafe.contact" or "board.task"') },
    },
    async ({ type: typeName }) => {
      const desc = catalog.describe(typeName);
      return text(desc ? yaml(desc) : `type not found: ${typeName}`);
    },
  );

  mcp.registerTool(
    'search_types',
    {
      description: 'Search types by keyword across names, titles, property names, and action names. Use to find types relevant to a task.',
      inputSchema: { query: z.string().describe('Search keyword, e.g. "order", "mail", "contact"') },
    },
    async ({ query }) => text(yaml(catalog.search(query))),
  );

  return mcp;
}

export function extractToken(req: import('node:http').IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  // C5: query-string `?token=` rejected — leaks to access logs/Referer/history
  return null;
}

// ── C5: auth resolution & session binding ──

const PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-real-ip', 'via',
  'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-client-ip', 'cf-connecting-ip', 'true-client-ip', 'cdn-loop',
] as const;

export function hasProxyHeaders(req: import('node:http').IncomingMessage): boolean {
  // Presence-check (not truthiness): empty-string header value is still a
  // proxy indicator. Headers are normalized lowercase by Node's HTTP parser.
  for (const h of PROXY_HEADERS) {
    if (h in req.headers) return true;
  }
  return false;
}

const TTL_FLOOR_MS = 60_000;                   // 1 minute
const TTL_CEILING_MS = 60 * 60_000;            // 1 hour (was 24h — tightened r3)
const TTL_DEFAULT_MS = 60 * 60_000;            // 1 hour

export function parseDevTtlMs(raw: string | undefined): number {
  if (raw === undefined) return TTL_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < TTL_FLOOR_MS || n > TTL_CEILING_MS) {
    console.warn(`[mcp] MCP_DEV_SESSION_TTL_MS=${raw} invalid (must be ${TTL_FLOOR_MS}..${TTL_CEILING_MS}), using default ${TTL_DEFAULT_MS}`);
    return TTL_DEFAULT_MS;
  }
  return Math.floor(n);
}

const DEV_SESSION_TTL_MS = parseDevTtlMs(process.env.MCP_DEV_SESSION_TTL_MS);

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function isLoopbackPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  if (addr.startsWith('127.')) return true;
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}

export function isDevAdminEnabled(
  configuredHost: string,
  peerAddr: string | undefined,
  hasProxy = false,
): boolean {
  if (hasProxy) return false;   // C5 round 2: never trust dev fallback through any proxy
  return (
    process.env.NODE_ENV === 'development' &&
    process.env.MCP_DEV_ADMIN === '1' &&
    isLoopbackHost(configuredHost) &&
    isLoopbackPeer(peerAddr)
  );
}

export type SessionAuth =
  | { kind: 'token'; userId: string; token: string; claims: string[] }
  | { kind: 'dev'; expiresAt: number };

export type AuthResolution =
  // claims is the EFFECTIVE claim set used for ACL — derived from buildClaims
  // (token kind) or hardcoded admin (dev kind). Handler must pass these into
  // buildMcpServer; do NOT fall back to session.claims on the bootstrap path.
  | { ok: true; session: Session; claims: string[]; auth: SessionAuth }
  | { ok: false; status: 401; body: { error: string; message?: string } };

export async function resolveMcpAuth(
  store: Tree,
  token: string | null,
  configuredHost: string,
  peerAddr: string | undefined,
  hasProxy = false,
): Promise<AuthResolution> {
  if (token) {
    const session = await resolveToken(store, token);
    if (!session) return {
      ok: false, status: 401,
      body: { error: 'invalid_token', message: 'Token expired or unknown' },
    };
    // C5 r3: always recompute via buildClaims for MCP — explicit session claims
    // are not trusted as static grants here; user/group changes must propagate.
    const claims = await buildClaims(store, session.userId);
    return { ok: true, session, claims, auth: { kind: 'token', userId: session.userId, token, claims } };
  }
  if (isDevAdminEnabled(configuredHost, peerAddr, hasProxy)) {
    console.warn('[mcp] ⚠️  DEV MODE: NODE_ENV=development + MCP_DEV_ADMIN=1 + loopback host & peer (no proxy) — granting admin without token.');
    const claims = ['u:mcp-dev', 'authenticated', 'admins'];
    return {
      ok: true,
      session: { userId: 'mcp-dev' } as Session,
      claims,
      auth: { kind: 'dev', expiresAt: Date.now() + DEV_SESSION_TTL_MS },
    };
  }
  return {
    ok: false, status: 401,
    body: { error: 'token_required', message: 'Pass token via Authorization: Bearer <token>' },
  };
}

export type RevalResult =
  | { ok: true }
  | { ok: false; status: 401; body: { error: string; message?: string }; evict: boolean };

function sameClaimSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const c of b) if (!set.has(c)) return false;
  return true;
}

export async function revalidateSessionAuth(
  store: Tree,
  cached: SessionAuth,
  token: string | null,
  configuredHost: string,
  peerAddr: string | undefined,
  hasProxy = false,
): Promise<RevalResult> {
  if (cached.kind === 'token') {
    // Wrong token but legit cached session must NOT be evicted (sid-disclosure DoS guard).
    if (token !== cached.token) return {
      ok: false, status: 401,
      body: { error: 'token_mismatch', message: 'Reconnect must present the original Bearer token' },
      evict: false,
    };
    const fresh = await resolveToken(store, token);
    if (!fresh || fresh.userId !== cached.userId) return {
      ok: false, status: 401,
      body: { error: 'token_invalid', message: 'Token revoked or expired' },
      evict: true,
    };
    // Claims drift detection (round 2 + 3): always recompute from current state
    // (ignore stored session.claims for MCP — see resolveMcpAuth comment).
    const currentClaims = await buildClaims(store, fresh.userId);
    if (!sameClaimSet(currentClaims, cached.claims)) return {
      ok: false, status: 401,
      body: { error: 'claims_changed', message: 'User permissions changed; reinitialize' },
      evict: true,
    };
    return { ok: true };
  }
  if (Date.now() > cached.expiresAt) return {
    ok: false, status: 401,
    body: { error: 'dev_session_expired', message: 'Reinitialize MCP session' },
    evict: true,
  };
  if (!isDevAdminEnabled(configuredHost, peerAddr, hasProxy)) return {
    ok: false, status: 401,
    body: { error: 'dev_mode_disabled' },
    evict: true,
  };
  return { ok: true };
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(s => {
    if (!s) return false;
    if (s === '*') {
      console.warn('[mcp] CORS: wildcard `*` in MCP_CORS_ORIGINS rejected (auth-capable endpoint requires exact origins)');
      return false;
    }
    return true;
  });
}

export function setCorsHeaders(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  const origin = req.headers.origin;
  const allowed = parseAllowedOrigins(process.env.MCP_CORS_ORIGINS);
  if (typeof origin === 'string') {
    res.setHeader('Vary', 'Origin');
    if (allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
}

function send401(
  res: import('node:http').ServerResponse,
  body: { error: string; message?: string },
): void {
  res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

type SessionEntry = { transport: StreamableHTTPServerTransport; mcp: McpServer; auth: SessionAuth };

/** Create MCP HTTP server. Returns server handle for lifecycle management. */
export function createMcpHttpServer(store: Tree, port: number, host = '127.0.0.1'): Server {
  const sessions = new Map<string, SessionEntry>();

  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = (req.url ?? '/').split('?')[0];
    if (url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const token = extractToken(req);
    const peerAddr = req.socket.remoteAddress;
    const proxy = hasProxyHeaders(req);

    // Reconnect: revalidate session auth on every hit
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_not_found' }));
        return;
      }
      const reval = await revalidateSessionAuth(store, entry.auth, token, host, peerAddr, proxy);
      if (!reval.ok) {
        // sid-disclosure DoS guard: only evict when failure proves the cached
        // session is no longer valid (token revoked, dev mode dropped, TTL).
        // Wrong-token reconnect MUST NOT kill a legit session.
        if (reval.evict) {
          sessions.delete(sessionId);
          try { entry.transport.close(); } catch { /* ignore */ }
        }
        send401(res, reval.body);
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    const auth = await resolveMcpAuth(store, token, host, peerAddr, proxy);
    if (!auth.ok) {
      send401(res, auth.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const mcp = await buildMcpServer(store, auth.session, auth.claims);
    await mcp.connect(transport);

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await transport.handleRequest(req, res);

    const sid = transport.sessionId;
    if (sid) sessions.set(sid, { transport, mcp, auth: auth.auth });
  };

  const server = createServer(handler);
  server.listen(port, host, () => console.log(`treenix mcp http://${host}:${port}/mcp`));
  return server;
}
