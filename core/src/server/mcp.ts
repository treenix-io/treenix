// Treenity MCP Server — exposes tree store as MCP tools
// StreamableHTTP transport, stateless, token auth via ?token= or Authorization header

import { createNode } from '#core';
import { verifyViewSource } from '#mods/uix/verify';
import { TypeCatalog } from '#schema/catalog';
import type { Tree } from '#tree';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type Server } from 'node:http';
import { z } from 'zod/v3';
import { executeAction } from './actions';
import { buildClaims, resolveToken, type Session, withAcl } from './auth';
import { deployPrefab } from './prefab';

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

/** Count non-system fields on a node */
function dataKeys(node: Record<string, unknown>) {
  return Object.keys(node).filter(k => !k.startsWith('$'));
}

async function buildMcpServer(store: Tree, session: Session, claims?: string[]) {
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
      const { items, total } = result;

      if (full) return text(yaml({ total, items }));

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
        return text(lines.join('\n') + `\n(${total} total)`);
      }

      // Default: ls-like — name, type, field count
      const lines = items.map(n => {
        const name = n.$path.split('/').at(-1);
        if (n.$type === 'dir') return `${name}/`;
        return `${name}  ${n.$type}  [${dataKeys(n).length}]`;
      });
      return text(lines.join('\n') + (total > items.length ? `\n(${total} total)` : ''));
    },
  );

  mcp.registerTool(
    'set_node',
    {
      description: 'Create or update a node',
      inputSchema: {
        path: z.string(),
        type: z.string(),
        components: z.record(z.unknown()).optional(),
        acl: z.array(z.object({ g: z.string(), p: z.number() })).optional(),
        owner: z.string().optional(),
      },
    },
    async ({ path, type, components, acl, owner }) => {
      const existing = await aclStore.get(path);
      const node = existing ?? createNode(path, type);
      if (!existing) node.$type = type;
      if (components) {
        for (const [k, v] of Object.entries(components)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          // LLMs often wrap node-level fields in a component matching the node $type.
          // Flatten: merge as plain fields instead of creating a redundant component.
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
      description: 'Execute an action on a node or component. Actions are methods registered on types.',
      inputSchema: {
        path: z.string(),
        action: z.string(),
        type: z.string().optional(),   // component $type for verification/scan
        key: z.string().optional(),    // component field key for direct lookup
        data: z.record(z.unknown()).optional(),
      },
    },
    async ({ path, action, type, key, data }) => {
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
      description: 'Remove a node by path',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
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

function extractToken(req: import('node:http').IncomingMessage): string | null {
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
export function createMcpHttpServer(store: Tree, port: number): Server {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = (req.url ?? '/').split('?')[0];
    if (url !== '/mcp') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    // Auth: token from ?token= or Authorization header
    // Dev mode: localhost without TENANT gets admin session (no token needed)
    const token = extractToken(req);
    let session: Session | null = null;
    let devClaims: string[] | undefined;
    if (token) {
      session = await resolveToken(store, token);
    } else if (!process.env.TENANT) {
      session = { userId: 'mcp-dev' } as Session;
      devClaims = ['u:mcp-dev', 'authenticated', 'admins'];
    }
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('token required (?token= or Authorization: Bearer)');
      return;
    }

    // Stateless: fresh transport + server per request, ACL-wrapped
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = await buildMcpServer(store, session, devClaims);
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });

  server.listen(port, '127.0.0.1', () => console.log(`treenity mcp :${port}`));
  return server;
}
