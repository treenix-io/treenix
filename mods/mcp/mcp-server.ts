// Treenity MCP Server — exposes tree store as MCP tools
// StreamableHTTP transport, stateless, token auth via ?token= or Authorization header

import { requestApproval } from '#agent/guardian';
import { AiPolicy } from '#agent/types';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createNode, getComponent } from '@treenity/core';
import { matchesAny } from '@treenity/core/glob';
import { verifyViewSource } from '@treenity/core/mods/uix/verify';
import { TypeCatalog } from '@treenity/core/schema/catalog';
import { executeAction } from '@treenity/core/server/actions';
import { buildClaims, resolveToken, type Session, withAcl } from '@treenity/core/server/auth';
import { deployPrefab } from '@treenity/core/server/prefab';
import type { Tree } from '@treenity/core/tree';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod/v3';


// Guardian policy check for MCP write operations
// Reads global policy from /agents/guardian, checks deny → escalate → allow
export type McpGuardianResult = { allowed: true } | { allowed: false; reason: string };


export async function checkMcpGuardian(store: Tree, toolName: string, input?: string): Promise<McpGuardianResult> {
  try {
    const guardianNode = await store.get('/agents/guardian');
    if (!guardianNode) return { allowed: false, reason: 'no Guardian configured at /agents/guardian — all writes denied' };

    const policy = getComponent(guardianNode, AiPolicy);
    if (!policy || policy.$type !== 'ai.policy') return { allowed: false, reason: 'invalid Guardian policy type — writes denied' };

    const allow = (policy.allow as string[]) ?? [];
    const deny = (policy.deny as string[]) ?? [];
    const escalate = (policy.escalate as string[]) ?? [];

    // Check both specific subject and coarse fallback: deny wins if either matches
    if (matchesAny(deny, toolName)) return { allowed: false, reason: `denied by Guardian: ${toolName}` };

    if (matchesAny(escalate, toolName)) {
      const approved = await requestApproval(store, {
        agentPath: '/agents/mcp',
        role: 'mcp',
        tool: toolName,
        input: input?.slice(0, 500) ?? '',
        reason: 'MCP tool requires approval',
      });
      return approved
        ? { allowed: true }
        : { allowed: false, reason: `🔐 "${toolName}" was denied or timed out. Use guardian_approve to pre-approve this pattern.` };
    }

    if (matchesAny(allow, toolName)) return { allowed: true };

    // Unknown tool via MCP → deny by default (safer than escalate for external callers)
    return { allowed: false, reason: `not in Guardian allow list: ${toolName}. Use Treenity Agent Office for write operations.` };
  } catch (err) {
    console.error('[mcp-guardian] failed to check policy:', err);
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
const catalog = new TypeCatalog();

function dataKeys(node: Record<string, unknown>) {
  return Object.keys(node).filter(k => !k.startsWith('$'));
}

export async function buildMcpServer(store: Tree, session: Session, claims?: string[]) {
  claims ??= await buildClaims(store, session.userId);
  const aclStore = withAcl(store, session.userId, claims);

  const mcp = new McpServer({ name: 'treenity', version: '1.0.0' });

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
      const guard = await checkMcpGuardian(store, 'mcp__treenity__set_node', JSON.stringify({ path, type }));
      if (!guard.allowed) return text(`🛑 Guardian: ${guard.reason}`);
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
      const guard = await checkMcpGuardian(store, 'mcp__treenity__execute', JSON.stringify({ path, action }));
      if (!guard.allowed) return text(`🛑 Guardian: ${guard.reason}`);
      // Action-level deny check — blocks only explicitly denied actions (e.g. "mcp__treenity__execute:run")
      // Main execute check above already handles allow/escalate; this is an additional deny filter
      const guardianNode = await store.get('/agents/guardian');
      if (guardianNode) {
        const p = getComponent(guardianNode, AiPolicy);
        if (p && matchesAny((p.deny as string[]) ?? [], `mcp__treenity__execute:${action}`)) {
          return text(`🛑 Guardian: denied action "${action}"`);
        }
      }
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
      const guard = await checkMcpGuardian(store, 'mcp__treenity__deploy_prefab', JSON.stringify({ source, target }));
      if (!guard.allowed) return text(`🛑 Guardian: ${guard.reason}`);
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
      const guard = await checkMcpGuardian(store, 'mcp__treenity__remove_node', path);
      if (!guard.allowed) return text(`🛑 Guardian: ${guard.reason}`);
      const ok = await aclStore.remove(path);
      return text(ok ? `removed: ${path}` : `not found: ${path}`);
    },
  );

  // ── Discovery tools — powered by TypeCatalog ──

  mcp.registerTool(
    'catalog',
    {
      description: 'List all registered types with title, properties, and action names. Use this first to discover what types exist.',
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

  const qs = (req.url ?? '').split('?')[1];
  if (qs) {
    const match = qs.match(/(?:^|&)token=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/** Create MCP HTTP server. Returns server handle for lifecycle management. */
export function createMcpHttpServer(store: Tree, port: number, host = '127.0.0.1'): Server {

  // Session map: sessionId → { transport, mcp } — keeps connections alive for reconnect
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();

  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
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

    // Reconnect: existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) {
        await entry.transport.handleRequest(req, res);
        return;
      }
      // Stale session — tell client to re-initialize
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_not_found' }));
      return;
    }

    // Auth
    const token = extractToken(req);
    let session: Session | null = null;
    let devClaims: string[] | undefined;
    if (token) {
      session = await resolveToken(store, token);
    } else if (!process.env.TENANT) {
      console.warn('[mcp] ⚠️  DEV MODE: no TENANT set — all MCP requests have ADMIN access. Set TENANT env for production.');
      session = { userId: 'mcp-dev' } as Session;
      devClaims = ['u:mcp-dev', 'authenticated', 'admins'];
    }
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token_required', message: 'Pass token via ?token= or Authorization: Bearer' }));
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const mcp = await buildMcpServer(store, session, devClaims);
    await mcp.connect(transport);

    // Track session for reconnect, clean up on close
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await transport.handleRequest(req, res);

    const sid = transport.sessionId;
    if (sid) sessions.set(sid, { transport, mcp });
  };

  const server = createServer(handler);
  server.listen(port, host, () => console.log(`treenity mcp http://${host}:${port}/mcp`));
  return server;
}
