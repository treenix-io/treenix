// Treenix MCP Server — exposes tree store as MCP tools
// StreamableHTTP transport, stateful sessions, token auth via Authorization: Bearer header

import { rememberRule, requestApproval, resolveVerdict } from '#agent/guardian';
import { AiPolicy } from '#agent/types';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getComponent, getMeta, resolve } from '@treenx/core';
import { matchesAny } from '@treenx/core/glob';
import type { CatalogActionDoc, CatalogEntry, CatalogPropertyDoc } from '@treenx/core/schema/catalog';
import type { MethodSchema, PropertySchema, TypeSchema } from '@treenx/core/schema/types';
import { executeAction } from '@treenx/core/server/actions';
import { buildClaims, resolveToken, type Session, withAcl } from '@treenx/core/server/auth';
import { resolveRef, type Tree } from '@treenx/core/tree';
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

/** Compact YAML serializer — readable for LLMs, much less noisy than JSON */
export function yaml(val: unknown, depth = 0, maxStr = 300): string {
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
      const childPad = '  '.repeat(depth + 1);
      const lines = inner.split('\n').map(line =>
        line.startsWith(childPad) ? line.slice(childPad.length) : line,
      );
      return lines.length === 1
        ? `${pad}- ${lines[0]}`
        : `${pad}- ${lines[0]}\n${lines.slice(1).map(l => `${pad}  ${l}`).join('\n')}`;
    }).join('\n');
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    if (!entries.length) return '{}';
    return entries.map(([k, v]) => {
      if (v != null && typeof v === 'object') {
        const inner = yaml(v, depth + 1, maxStr);
        if (Array.isArray(v) && !inner.includes('\n')) return `${pad}${k}: ${inner}`;
        return `${pad}${k}:\n${inner}`;
      }
      return `${pad}${k}: ${yaml(v, 0, maxStr)}`;
    }).join('\n');
  }
  return String(val);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatList(label: string, values: string[], lines: string[]) {
  if (!values.length) return;
  const inline = values.join(', ');
  if (inline.length <= 100) {
    lines.push(`  ${label}: ${inline}`);
    return;
  }
  lines.push(`  ${label}:`);
  for (const value of values) lines.push(`    - ${value}`);
}

function formatFieldNote(name: string, doc: CatalogPropertyDoc): string {
  const hints: string[] = [];
  if (doc.format) hints.push(doc.format);
  if (doc.refType) hints.push(`ref ${doc.refType}`);

  const human = oneLine([doc.title, doc.description].filter(Boolean).join(' — '));
  const detail = [hints.join(', '), human].filter(Boolean).join(' — ');
  return detail ? `    - ${name}: ${detail}` : `    - ${name}`;
}

function formatAction(name: string, doc?: CatalogActionDoc): string {
  if (!doc) return `    - ${name}`;

  const args = doc.arguments?.length ? `(${doc.arguments.join(', ')})` : '';
  const label = oneLine([doc.title, doc.description].filter(Boolean).join(' — '));
  const streaming = doc.streaming ? ' [stream]' : '';
  return `    - ${name}${args}${streaming}${label ? ` — ${label}` : ''}`;
}

function formatCatalogEntry(entry: CatalogEntry): string {
  const lines = [`- ${entry.name}${entry.title ? ` — ${oneLine(entry.title)}` : ''}`];
  if (entry.description) lines.push(`  ${oneLine(entry.description)}`);

  formatList('fields', entry.properties, lines);

  const fieldNotes = Object.entries(entry.propertyDocs ?? {});
  if (fieldNotes.length) {
    lines.push('  field notes:');
    for (const [name, doc] of fieldNotes) lines.push(formatFieldNote(name, doc));
  }

  const actionDocs = entry.actionDocs ?? {};
  if (entry.actions.length) {
    lines.push('  actions:');
    for (const name of entry.actions) lines.push(formatAction(name, actionDocs[name]));
  }

  return lines.join('\n');
}

export function formatCatalog(entries: CatalogEntry[]): string {
  return entries.map(formatCatalogEntry).join('\n\n');
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

  const caps = mcp.server.getClientCapabilities();
  if (caps?.elicitation?.form) {
    try {
      const narrow = guard.subjects[0] ?? tool;
      const broad = guard.subjects.at(-1) ?? tool;
      const result = await mcp.server.elicitInput({
        mode: 'form',
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
      console.error('[mcp-guardian] elicitInput failed:', err);
      return text(`🛑 Guardian: approval prompt failed: ${(err as Error).message}`);
    }
  }

  if (process.env.MCP_GUARDIAN_TREE_APPROVAL !== '1') {
    return text('🛑 Guardian: this MCP client did not advertise form elicitation support; approval cannot be requested inline.');
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

type McpServerBuildOpts = {
  target?: string;
};

// R5-NEW-1: bound recursive Zod-from-JSON-Schema expansion. A pathological mod schema
// (deeply-nested anyOf, huge enum, or recursive properties) would otherwise burn CPU/stack
// at MCP build time. Caps mirror R4-MOUNT-4's assertSafeSchema constraints.
const ZOD_DEPTH_MAX = 16;
const ZOD_UNION_MAX = 100;
const ZOD_PROPS_MAX = 200;

function zodForProperty(prop: PropertySchema = {}, depth = 0): z.ZodTypeAny {
  if (depth > ZOD_DEPTH_MAX)
    throw new Error(`MCP schema too deep (>${ZOD_DEPTH_MAX} levels) — pathological schema rejected`);

  let schema: z.ZodTypeAny;
  if (prop.anyOf?.length) {
    if (prop.anyOf.length > ZOD_UNION_MAX)
      throw new Error(`MCP schema anyOf too large (>${ZOD_UNION_MAX} variants)`);
    const variants = prop.anyOf.map(p => zodForProperty(p, depth + 1));
    schema = variants.length === 1
      ? variants[0]
      : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if (prop.enum?.length) {
    if (prop.enum.length > ZOD_UNION_MAX)
      throw new Error(`MCP schema enum too large (>${ZOD_UNION_MAX} entries)`);
    const literals: z.ZodTypeAny[] = prop.enum.map(v => z.literal(v));
    schema = literals.length === 1
      ? literals[0]
      : z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else {
    switch (prop.type) {
      case 'string':
        schema = z.string();
        break;
      case 'number':
      case 'integer':
        schema = z.number();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'array':
        schema = z.array(zodForProperty(prop.items, depth + 1));
        break;
      case 'object':
        schema = z.object(shapeForProperties(prop.properties ?? {}, prop.required ?? [], depth + 1)).passthrough();
        break;
      default:
        schema = z.unknown();
        break;
    }
  }
  if (prop.description) schema = schema.describe(prop.description);
  return schema;
}

function shapeForProperties(
  properties: Record<string, PropertySchema>,
  required: readonly string[] = [],
  depth = 0,
): z.ZodRawShape {
  const propEntries = Object.entries(properties);
  if (propEntries.length > ZOD_PROPS_MAX)
    throw new Error(`MCP schema has too many properties (>${ZOD_PROPS_MAX})`);
  const req = new Set(required);
  const shape: z.ZodRawShape = {};
  for (const [name, prop] of propEntries) {
    const schema = zodForProperty(prop, depth);
    shape[name] = req.has(name) ? schema : schema.optional();
  }
  return shape;
}

function methodInputSchema(method: MethodSchema): z.AnyZodObject {
  const args = method.arguments ?? [];
  if (args.length === 1 && args[0].type === 'object') {
    return z.object(shapeForProperties(args[0].properties ?? {}, args[0].required ?? [])).passthrough();
  }
  const shape: z.ZodRawShape = {};
  for (const arg of args) shape[arg.name] = zodForProperty(arg);
  return z.object(shape).passthrough();
}

function methodPayload(method: MethodSchema, args: Record<string, unknown>): unknown {
  const actionArgs = method.arguments ?? [];
  if (actionArgs.length === 0) return {};
  if (actionArgs.length === 1) {
    const arg = actionArgs[0];
    return arg.type === 'object' ? args : args[arg.name];
  }
  return args;
}

function actionIsGuarded(type: string, action: string, method: MethodSchema): boolean {
  const meta = getMeta(type, `action:${action}`);
  if (meta?.noOptimistic === true) return true;
  if (typeof (method as Record<string, unknown>).mutation === 'string') return true;
  return false;
}

function delegatesToAction(method: MethodSchema): boolean {
  const arg = method.arguments?.[0];
  return arg?.type === 'object' && !!arg.properties?.path && !!arg.properties?.action;
}

async function callIsGuarded(tree: Tree, type: string, action: string, method: MethodSchema, args: Record<string, unknown>): Promise<boolean> {
  if (!delegatesToAction(method)) return actionIsGuarded(type, action, method);

  const targetPath = typeof args.path === 'string' ? args.path : '';
  const targetAction = typeof args.action === 'string' ? args.action : '';
  if (!targetPath || !targetAction) return true;

  const explicitType = typeof args.type === 'string' ? args.type : '';
  const targetType = explicitType || (await tree.get(targetPath))?.$type || '';
  const targetMethod = targetType
    ? (resolve(targetType, 'schema') as (() => TypeSchema) | null)?.()?.methods?.[targetAction]
    : undefined;
  if (!targetMethod) return true;
  return actionIsGuarded(targetType, targetAction, targetMethod);
}

function delegatedActionCall(method: MethodSchema, args: Record<string, unknown>) {
  if (!delegatesToAction(method)) return null;
  const path = typeof args.path === 'string' ? args.path : '';
  const action = typeof args.action === 'string' ? args.action : '';
  if (!path || !action) return null;
  return {
    path,
    action,
    type: typeof args.type === 'string' ? args.type : undefined,
    key: typeof args.key === 'string' ? args.key : undefined,
    data: args.data,
  };
}

function actionDescription(action: string, method: MethodSchema): string {
  return [method.title, method.description, (method as Record<string, unknown>).mutation]
    .filter((v): v is string => typeof v === 'string' && !!v)
    .map(oneLine)
    .join(' — ') || `Execute ${action}`;
}

async function resolveTargetNode(tree: Tree, targetPath: string) {
  const raw = await tree.get(targetPath);
  if (!raw) throw new Error(`MCP target node not found: ${targetPath}`);
  return resolveRef(tree, raw);
}

export async function buildMcpServer(store: Tree, session: Session, claims?: string[], opts: McpServerBuildOpts = {}) {
  claims ??= session.claims ?? await buildClaims(store, session.userId);
  const aclStore = withAcl(store, session.userId, claims);
  const targetPath = opts.target ?? '/sys/mcp/tools';
  const targetNode = await resolveTargetNode(aclStore, targetPath);
  const schema = (resolve(targetNode.$type, 'schema') as (() => TypeSchema) | null)?.();
  if (!schema?.methods) throw new Error(`MCP target type has no methods: ${targetNode.$type}`);

  const mcp = new McpServer({ name: 'treenix', version: '1.0.0' });

  /** Check guardian policy; block on escalation until human approves */
  async function guarded(tool: string, args: Record<string, unknown>) {
    const guard = await checkMcpGuardian(store, { tool, args });
    return guardBlock(guard, store, session.userId, mcp);
  }

  for (const [action, method] of Object.entries(schema.methods)) {
    mcp.registerTool(
      action,
      {
        description: actionDescription(action, method),
        inputSchema: methodInputSchema(method),
      },
      async (args) => {
        const callArgs = args as Record<string, unknown>;
        if (await callIsGuarded(aclStore, targetNode.$type, action, method, callArgs)) {
          const blocked = await guarded(action, { target: targetNode.$path, ...callArgs });
          if (blocked) return blocked;
        }
        const delegated = delegatedActionCall(method, callArgs);
        if (delegated) {
          const result = await executeAction(
            aclStore,
            delegated.path,
            delegated.type,
            delegated.key,
            delegated.action,
            delegated.data,
            { userId: session.userId, claims },
          );
          return text(typeof result === 'string' ? result : yaml(result ?? { ok: true }));
        }
        const result = await executeAction(
          aclStore,
          targetNode.$path,
          targetNode.$type,
          undefined,
          action,
          methodPayload(method, callArgs),
          { userId: session.userId, claims },
        );
        return text(typeof result === 'string' ? result : yaml(result ?? { ok: true }));
      },
    );
  }

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
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  body: { error: string; message?: string },
  opts: McpHandlerOptions = {},
): void {
  const metadataUrl = absoluteResourceUrl(req, protectedResourceMetadataPath(opts.routePath ?? '/mcp'));
  res.setHeader('WWW-Authenticate', `Bearer realm="mcp", resource_metadata="${metadataUrl}"`);
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

type SessionEntry = { transport: StreamableHTTPServerTransport; mcp: McpServer; auth: SessionAuth };

export type McpHandlerOptions = {
  routePath?: string;
  target?: string;
  authorizationServer?: string;
};

const PROTECTED_RESOURCE_METADATA_ROOT = '/.well-known/oauth-protected-resource';

export function protectedResourceMetadataPath(routePath: string): string {
  const route = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return route === '/' ? PROTECTED_RESOURCE_METADATA_ROOT : `${PROTECTED_RESOURCE_METADATA_ROOT}${route}`;
}

function requestOrigin(req: import('node:http').IncomingMessage): string {
  const host = req.headers.host;
  if (!host) return 'http://localhost';
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = process.env.TRUST_PROXY === 'true' && typeof forwardedProto === 'string'
    ? forwardedProto.split(',')[0].trim()
    : 'http';
  return `${proto || 'http'}://${host}`;
}

function absoluteResourceUrl(req: import('node:http').IncomingMessage, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${requestOrigin(req)}${url.startsWith('/') ? url : `/${url}`}`;
}

export function protectedResourceMetadata(
  req: import('node:http').IncomingMessage,
  opts: McpHandlerOptions = {},
) {
  const routePath = opts.routePath ?? '/mcp';
  const authorizationServer = opts.authorizationServer || requestOrigin(req);
  return {
    resource: absoluteResourceUrl(req, routePath),
    resource_name: 'Treenix MCP',
    bearer_methods_supported: ['header'],
    scopes_supported: ['treenix'],
    authorization_servers: [absoluteResourceUrl(req, authorizationServer)],
  };
}

export function createMcpResourceMetadataHandler(opts: McpHandlerOptions = {}) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(protectedResourceMetadata(req, opts)));
  };
}

export function createMcpRouteHandler(store: Tree, host = '127.0.0.1', opts: McpHandlerOptions = {}) {
  const sessions = new Map<string, SessionEntry>();

  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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
        send401(req, res, reval.body, opts);
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    const auth = await resolveMcpAuth(store, token, host, peerAddr, proxy);
    if (!auth.ok) {
      send401(req, res, auth.body, opts);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const mcp = await buildMcpServer(store, auth.session, auth.claims, { target: opts.target });
    await mcp.connect(transport);

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await transport.handleRequest(req, res);

    const sid = transport.sessionId;
    if (sid) sessions.set(sid, { transport, mcp, auth: auth.auth });
  };
}

/** Create MCP HTTP server. Returns server handle for tests and standalone usage. */
export function createMcpHttpServer(store: Tree, port: number, host = '127.0.0.1', opts: McpHandlerOptions = {}): Server {
  const routePath = opts.routePath ?? '/mcp';
  const handler = createMcpRouteHandler(store, host, { ...opts, routePath });
  const metadataHandler = createMcpResourceMetadataHandler({ ...opts, routePath });
  const metadataPath = protectedResourceMetadataPath(routePath);

  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === metadataPath) {
      await metadataHandler(req, res);
      return;
    }
    if (url !== routePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    await handler(req, res);
  });
  server.listen(port, host, () => console.log(`treenix mcp http://${host}:${port}/mcp`));
  return server;
}
