// Guardian — extensible tool policy for AI agents.
// Cascade: agent ai.policy → global ai.policy (/agents/guardian) → hardcoded fallback.
// Escalation: creates ai.approval node → Promise resolution via pendingPermissions.

import { pendingPermissions, type PermissionMeta, type PermissionRule, resolvePermission } from '#metatron/permissions';
import { MetatronConfig } from '#metatron/types';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createNode, getComponent } from '@treenity/core';
import { registerType, setComponent } from '@treenity/core/comp';
import { matchesAny } from '@treenity/core/glob';
import type { Tree } from '@treenity/core/tree';
import { AiPolicy } from './types';

// ── Approval type — lives in /agents/approvals/{id} ──

export class AiApproval {
  agentPath = '';
  agentRole = '';
  tool = '';
  /** @format textarea */
  input = '';
  status: 'pending' | 'approved' | 'denied' = 'pending';
  reason = '';
  createdAt = 0;
  resolvedAt = 0;

  /** @description Approve this tool usage */
  approve(data?: {
    /** Remember this decision for future calls */
    remember?: 'agent' | 'global'
  }) {
    if (this.status !== 'pending') throw new Error('already resolved');
    this.status = 'approved';
    this.resolvedAt = Date.now();
    const id = (this as any).$path?.split('/').pop();
    if (id) resolvePermission(id, true, {
      tool: this.tool,
      input: this.input,
      agentPath: this.agentPath,
      scope: data?.remember,
    });
  }

  /** @description Deny this tool usage */
  deny(data?: {
    /** Remember this decision for future calls */
    remember?: 'agent' | 'global'
  }) {
    if (this.status !== 'pending') throw new Error('already resolved');
    this.status = 'denied';
    this.resolvedAt = Date.now();
    const id = (this as any).$path?.split('/').pop();
    if (id) resolvePermission(id, false, {
      tool: this.tool,
      input: this.input,
      agentPath: this.agentPath,
      scope: data?.remember,
    });
  }
}

registerType('ai.approval', AiApproval);

// ── ToolPolicy shape (runtime, with RegExp) ──

export type ToolPolicy = {
  allow: string[];
  deny: string[];
  escalate: string[];
};

// ── Minimal fallback — read-only, everything else escalated ──

const FALLBACK_POLICY: ToolPolicy = {
  allow: [
    'mcp__treenity__get_node', 'mcp__treenity__list_children',
    'mcp__treenity__catalog', 'mcp__treenity__describe_type',
    'mcp__treenity__search_types',
  ],
  deny: [],
  escalate: ['mcp__treenity__set_node', 'mcp__treenity__execute', 'mcp__treenity__remove_node'],
};

// ── Convert ai.policy node data → runtime ToolPolicy ──

function policyFromNode(p: AiPolicy): ToolPolicy {
  return {
    allow: [...p.allow],
    deny: [...p.deny],
    escalate: [...p.escalate],
  };
}

/** Merge two policies: b overrides a (more specific wins) */
function mergePolicies(base: ToolPolicy, override: ToolPolicy): ToolPolicy {
  const allow = [...new Set([...base.allow, ...override.allow])];
  const deny = [...new Set([...base.deny, ...override.deny])];
  const escalate = [...new Set([...base.escalate, ...override.escalate])];
  // Remove from escalate/deny if explicitly allowed in override
  const cleanEscalate = escalate.filter(t => !override.allow.includes(t));
  const cleanDeny = deny.filter(t => !override.allow.includes(t));
  return {
    allow,
    deny: cleanDeny,
    escalate: cleanEscalate,
  };
}

const GUARDIAN_PATH = '/agents/guardian';

/** Resolve policy cascade: agent → global → fallback */
async function resolvePolicy(store: Tree, agentPath: string): Promise<ToolPolicy> {
  const hardcoded = FALLBACK_POLICY;

  // Global policy from /agents/guardian
  let base = hardcoded;
  try {
    const guardianNode = await store.get(GUARDIAN_PATH);
    if (guardianNode) {
      const globalPolicy = getComponent(guardianNode, AiPolicy);
      if (globalPolicy && (globalPolicy.allow.length || globalPolicy.deny.length || globalPolicy.escalate.length)) {
        base = mergePolicies(hardcoded, policyFromNode(globalPolicy));
      }
    }
  } catch { /* no guardian node yet */ }

  // Agent-level policy
  try {
    const agentNode = await store.get(agentPath);
    if (agentNode) {
      const agentPolicy = getComponent(agentNode, AiPolicy);
      if (agentPolicy && (agentPolicy.allow.length || agentPolicy.deny.length || agentPolicy.escalate.length)) {
        return mergePolicies(base, policyFromNode(agentPolicy));
      }
    }
  } catch { /* agent has no policy component */ }

  return base;
}

// ── Build metatron-compatible PermissionRule[] ──

/** Static fallback rules for SDK upfront hints. Real enforcement in canUseTool. */
export function buildPermissionRules(_role: string): PermissionRule[] {
  const policy = FALLBACK_POLICY;
  const rules: PermissionRule[] = [];

  for (const tool of policy.deny) rules.push({ tool, pathPattern: '', policy: 'deny' });
  for (const tool of policy.escalate) rules.push({ tool, pathPattern: '', policy: 'ask-once' });
  for (const tool of policy.allow) rules.push({ tool, pathPattern: '', policy: 'allow' });

  return rules;
}


// ── Always-deny bash patterns ──

const DANGEROUS_BASH = [
  /rm\s+-rf/, /push\s+--force/, /reset\s+--hard/, /--no-verify/,
  /curl\b.*\|\s*(?:ba)?sh/, /wget\b.*\|\s*(?:ba)?sh/,   // pipe-to-shell
  /\beval\s+/,                                             // arbitrary eval
  /chmod\s+777/, /chmod\s+\+s/,                            // permission escalation
  /\bdd\s+.*of=\/dev\//, /\bmkfs\b/,                      // disk destruction
];

// ── Split bash command by operators, respecting quotes ──

export function splitBashParts(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\' && !inSingle) { cur += ch; escaped = true; continue; }
    if (ch === "'" && !inDouble) { cur += ch; inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { cur += ch; inDouble = !inDouble; continue; }

    if (!inSingle && !inDouble) {
      if (ch === '|' && cmd[i + 1] === '|') { parts.push(cur); cur = ''; i++; continue; }
      if (ch === '|') { parts.push(cur); cur = ''; continue; }
      if (ch === '&' && cmd[i + 1] === '&') { parts.push(cur); cur = ''; i++; continue; }
      if (ch === ';') { parts.push(cur); cur = ''; continue; }
    }

    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

// ── Escalation via tree nodes + Promise resolution ──

const APPROVAL_TIMEOUT = 60 * 60 * 1000; // 1 hour

export async function requestApproval(
  store: Tree,
  opts: { agentPath: string; role: string; tool: string; input: string; reason: string },
): Promise<boolean> {
  const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const path = `/agents/approvals/${id}`;

  await store.set(createNode(path, 'ai.approval', {
    agentPath: opts.agentPath,
    agentRole: opts.role,
    tool: opts.tool,
    input: opts.input.slice(0, 1000),
    status: 'pending',
    reason: opts.reason,
    createdAt: Date.now(),
  }));

  console.log(`[guardian] escalation: ${opts.role} wants ${opts.tool} → ${path}`);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(id);
      console.log(`[guardian] escalation timed out: ${path}`);
      resolve(false);
    }, APPROVAL_TIMEOUT);

    pendingPermissions.set(id, async (allow: boolean, meta?: PermissionMeta) => {
      clearTimeout(timer);

      // "Remember" — persist rule to tree policy
      if (meta?.scope && meta.tool) {
        try {
          await rememberRule(store, meta.tool, meta.input ?? '', allow, meta.agentPath ?? '', meta.scope);
        } catch (err) {
          console.error(`[guardian] failed to persist rule: ${err}`);
        }
      }

      resolve(allow);
    });
  });
}

/** Write a persistent rule to agent or global policy (with OCC retry) */
async function rememberRule(store: Tree, tool: string, _input: string, allow: boolean, agentPath: string, scope: string) {
  const targetPath = scope === 'agent' ? agentPath : GUARDIAN_PATH;
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const node = await store.get(targetPath);
    if (!node) return;

    const policy = getComponent(node, AiPolicy) ?? Object.assign(new AiPolicy(), { $type: 'ai.policy' });

    if (allow) {
      if (!policy.allow.includes(tool)) policy.allow.push(tool);
      policy.deny = policy.deny.filter(d => d !== tool);
      policy.escalate = policy.escalate.filter(e => e !== tool);
    } else {
      if (!policy.deny.includes(tool)) policy.deny.push(tool);
      policy.allow = policy.allow.filter(a => a !== tool);
      policy.escalate = policy.escalate.filter(e => e !== tool);
    }

    setComponent(node, AiPolicy, policy);
    try {
      await store.set(node);
      console.log(`[guardian] remembered: ${allow ? 'allow' : 'deny'} ${tool} → ${targetPath}`);
      return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('OptimisticConcurrencyError') && attempt < MAX_RETRIES - 1) {
        console.warn(`[guardian] OCC conflict on ${targetPath}, retry ${attempt + 1}`);
        continue;
      }
      throw err;
    }
  }
}

// ── Startup reconciliation ──

/** Result of reconciliation — agents that should be resumed */
export type ResumableAgent = {
  agentPath: string;
  taskPath: string;
};

export async function reconcileOnStartup(store: Tree): Promise<ResumableAgent[]> {
  const resumable: ResumableAgent[] = [];

  // Expire orphaned approvals
  try {
    const { items } = await store.getChildren('/agents/approvals');
    for (const approval of items) {
      if (approval.$type !== 'ai.approval' || approval.status !== 'pending') continue;
      await store.set({ ...approval, status: 'denied' as const, reason: 'expired: server restart', resolvedAt: Date.now() });
      console.log(`[guardian] expired orphaned approval: ${approval.$path}`);
    }
  } catch { /* no approvals dir */ }

  // Reconcile agents — resume those with sessionId, reset the rest
  try {
    const { items } = await store.getChildren('/agents');
    const resumablePaths: string[] = [];

    for (const node of items) {
      if (node.$type !== 'ai.agent') continue;
      if (node.status !== 'working' && node.status !== 'blocked') continue;

      // Check if agent has a session to resume
      const config = getComponent(node, MetatronConfig);
      const hasSession = config && typeof config.sessionId === 'string' && config.sessionId.length > 0;
      const taskPath = typeof node.currentTask === 'string' ? node.currentTask : '';

      if (hasSession && taskPath) {
        // Agent can resume — keep working status, collect for re-launch
        resumable.push({ agentPath: node.$path, taskPath });
        resumablePaths.push(node.$path);
        console.log(`[guardian] resumable agent: ${node.$path} → ${taskPath} (session ${config.sessionId.slice(0, 8)}...)`);
      } else {
        // No session — reset to idle
        await store.set({ ...node, status: 'idle', currentTask: '', taskRef: '' });
        console.log(`[guardian] reset stuck agent: ${node.$path}`);

        // Reset stuck metatron.tasks under this agent
        try {
          const { items: tasks } = await store.getChildren(`${node.$path}/tasks`);
          for (const task of tasks) {
            if (task.$type !== 'metatron.task' || task.status !== 'running') continue;
            await store.set({ ...task, status: 'error', result: 'interrupted: server restart' });
            console.log(`[guardian] reset stuck agent task: ${task.$path}`);
          }
        } catch { /* no tasks dir yet */ }
      }
    }

    // Update pool — keep resumable agents in active, clear the rest
    const poolNode = await store.get('/agents');
    if (poolNode && poolNode.$type === 'ai.pool') {
      await store.set({ ...poolNode, active: resumablePaths, queue: [] });
      if (resumablePaths.length) {
        console.log(`[guardian] pool active: [${resumablePaths.join(', ')}]`);
      } else {
        console.log(`[guardian] cleared pool active/queue`);
      }
    }
  } catch { /* */ }

  // Reset stuck task aiStatus — but skip tasks being resumed
  const resumedTaskPaths = new Set(resumable.map(r => r.taskPath));
  try {
    const { items } = await store.getChildren('/board/data');
    for (const task of items) {
      if (task.$type !== 'board.task') continue;
      if (resumedTaskPaths.has(task.$path)) continue;
      if (typeof task.aiStatus === 'string' && task.aiStatus) {
        await store.set({ ...task, aiStatus: '' });
        console.log(`[guardian] cleared aiStatus on: ${task.$path}`);
      }
    }
  } catch { /* no board */ }

  return resumable;
}

// ── canUseTool callback for Agent SDK ──

export function createCanUseTool(
  role: string,
  agentPath: string,
  store?: Tree,
) {
  const allow = (): PermissionResult => ({ behavior: 'allow' });
  const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });

  // Cache resolved policy (per agent run)
  let cachedPolicy: ToolPolicy | null = null;

  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {

    // Lazy-resolve policy from tree on first call
    if (!cachedPolicy) {
      cachedPolicy = store
        ? await resolvePolicy(store, agentPath)
        : FALLBACK_POLICY;
    }
    const policy = cachedPolicy;

    // Deny-list check first (bare tool name)
    if (matchesAny(policy.deny, toolName)) {
      return deny(`${role}: denied: ${toolName}`);
    }

    // Bash → split by pipes/operators, check each sub-command independently
    if (toolName === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command.trim() : '';

      // C14: normalize backslash escapes before safety check — prevents bypass via `git\ reset\ --hard`
      const normalized = cmd.replace(/\\(.)/g, '$1');

      // Hardcoded safety net — check full command (both raw and normalized)
      for (const pattern of DANGEROUS_BASH) {
        if (pattern.test(cmd) || pattern.test(normalized)) return deny(`blocked: ${cmd.slice(0, 60)}`);
      }

      // Split by newlines first, then by pipes/operators
      const lines = cmd.split(/\n/).map(l => l.trim()).filter(Boolean);

      // Check each line against safety net (belt-and-suspenders with full-string check above)
      for (const line of lines) {
        const normLine = line.replace(/\\(.)/g, '$1');
        for (const pattern of DANGEROUS_BASH) {
          if (pattern.test(line) || pattern.test(normLine)) return deny(`blocked: ${line.slice(0, 60)}`);
        }
      }

      // Split into sub-commands and check each
      const parts = lines.length > 0 ? lines.flatMap(l => splitBashParts(l)) : [];
      const effectiveNames = parts.map(p => `Bash:${p}`);

      // Any sub-command denied → deny entire command
      for (const eName of effectiveNames) {
        if (matchesAny(policy.deny, eName)) {
          return deny(`${role}: denied: ${eName}`);
        }
      }

      // Escalate BEFORE allow: explicit escalate beats wildcard allow
      const escalated = effectiveNames.filter(e => matchesAny(policy.escalate, e));
      if (escalated.length > 0) {
        if (store) {
          const approved = await requestApproval(store, {
            agentPath, role, tool: escalated[0], input: cmd.slice(0, 200),
            reason: 'requires approval',
          });
          return approved ? allow() : deny('denied by human');
        }
        return deny(`${role}: escalated but no store: ${escalated[0]}`);
      }

      // All sub-commands must be allowed — if any isn't, escalate as unknown
      const notAllowed = effectiveNames.filter(e => !matchesAny(policy.allow, e));
      if (notAllowed.length === 0 && effectiveNames.length > 0) {
        return allow();
      }

      // Unknown sub-commands → escalate
      const unknownName = notAllowed[0] ?? `Bash:${cmd}`;
      if (store) {
        const approved = await requestApproval(store, {
          agentPath, role, tool: unknownName, input: cmd.slice(0, 200),
          reason: 'unknown tool',
        });
        return approved ? allow() : deny('denied by human');
      }
      return deny(`${role}: not allowed: ${unknownName}`);
    }

    // Non-Bash tools — deny → escalate → allow → unknown
    // Escalate BEFORE allow: explicit "requires approval" beats wildcard allow.
    if (matchesAny(policy.deny, toolName)) {
      return deny(`${role}: denied: ${toolName}`);
    }
    if (matchesAny(policy.escalate, toolName)) {
      if (store) {
        const inputStr = JSON.stringify(input).slice(0, 500);
        const approved = await requestApproval(store, {
          agentPath, role, tool: toolName, input: inputStr,
          reason: 'requires approval',
        });
        return approved ? allow() : deny('denied by human');
      }
      return deny(`${role}: escalated but no store: ${toolName}`);
    }
    if (matchesAny(policy.allow, toolName)) {
      return allow();
    }

    // Unknown tool — escalate to human
    if (store) {
      const inputStr = JSON.stringify(input).slice(0, 500);
      const approved = await requestApproval(store, {
        agentPath, role, tool: toolName, input: inputStr,
        reason: 'unknown tool',
      });
      return approved ? allow() : deny('denied by human');
    }
    return deny(`${role}: not allowed: ${toolName}`);
  };
}
