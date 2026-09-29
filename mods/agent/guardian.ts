// Guardian — extensible tool policy for AI agents.
// Cascade: agent ai.policy → global ai.policy (/guardian) → hardcoded fallback.
// Escalation: creates ai.approval node; its status/remember fields ARE the
// resolution state — waiters poll the node, so approvals survive restarts.

import { type PermissionRule } from '#metatron/permissions';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createNode, getComponent, type NodeData } from '@treenx/core';
import { setComponent } from '@treenx/core/comp';
import { KernelError } from '@treenx/core/errors';
import { globMatch, matchesAny } from '@treenx/core/glob';
import type { Tree } from '@treenx/core/tree';
import { AiAgent, AiChat, AiPolicy, AiRunStatus } from './types';

// ── Specificity-aware policy resolution ──

// Total literal (non-wildcard) character count — more literals = more constrained.
// "set_node:/safe/*" → 15, "deploy_prefab:star/agents/star" → 22, "execute:*" → 8
function patternSpecificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}

// ── Mutating tools require an EXPLICIT allow (core-1prz) ──
// A wildcard in the TOOL segment of an allow pattern ('mcp__treenix__*', '*')
// never authorizes a mutating tool: polluted or sloppy policy data must not
// reopen ungated writes (the live-/guardian wildcard incident). Path/action
// scoping stays free ('mcp__treenix__set_node:/branches/*' is explicit).
// Deny and escalate are unaffected — wildcards may only restrict, never grant.

const MUTATING_TOOLS = new Set([
  'mcp__treenix__set_node', 'mcp__treenix__remove_node',
  'mcp__treenix__execute', 'mcp__treenix__deploy_prefab',
]);

function subjectTool(s: string): string {
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(0, i);
}

function allowGrants(pattern: string, subject: string): boolean {
  if (!globMatch(pattern, subject)) return false;
  const tool = subjectTool(subject);
  if (!MUTATING_TOOLS.has(tool)) return true;
  return subjectTool(pattern) === tool;
}

/** Resolve policy verdict across all subjects.
 *  Deny is absolute (any match → deny). For allow/escalate, we find the best
 *  matching pattern across ALL subjects using (subject_index, pattern_specificity).
 *  More specific subject (lower index) always wins. At same subject, exact pattern
 *  beats wildcard. At same specificity, escalate beats allow (fail-closed). */
export function resolveVerdict(
  policy: ToolPolicy,
  subjects: string[],
): 'allow' | 'escalate' | 'deny' | null {
  // Deny is absolute — check all subjects
  for (const s of subjects) {
    if (matchesAny(policy.deny, s)) return 'deny';
  }

  // Find best allow and escalate patterns by specificity.
  // Specificity = length of non-wildcard prefix (longer = more specific constraint).
  // e.g. "set_node:/safe/*" (prefix 15) > "set_node" (prefix 8) > "execute:*" (prefix 8) > "*" (prefix 0)
  let bestAllow = -1;
  let bestEsc = -1;

  for (const s of subjects) {
    for (const p of policy.allow) {
      if (!allowGrants(p, s)) continue;
      const score = patternSpecificity(p);
      if (score > bestAllow) bestAllow = score;
    }
    for (const p of policy.escalate) {
      if (!globMatch(p, s)) continue;
      const score = patternSpecificity(p);
      if (score > bestEsc) bestEsc = score;
    }
  }

  if (bestAllow < 0 && bestEsc < 0) return null;
  if (bestAllow >= 0 && bestEsc < 0) return 'allow';
  if (bestAllow < 0 && bestEsc >= 0) return 'escalate';

  // Both match — higher specificity wins; escalate wins ties (fail-closed)
  if (bestAllow > bestEsc) return 'allow';
  if (bestEsc > bestAllow) return 'escalate';
  return 'escalate'; // tie → fail-closed
}

// ── ToolPolicy shape (runtime, with RegExp) ──

export type ToolPolicy = {
  allow: string[];
  deny: string[];
  escalate: string[];
};

// ── Fail-closed fallback — deny destructive, escalate writes, allow reads ──

const FALLBACK_POLICY: ToolPolicy = {
  allow: [
    'mcp__treenix__get_node', 'mcp__treenix__list_children',
    'mcp__treenix__catalog', 'mcp__treenix__describe_type',
    'mcp__treenix__search_types',
    'mcp__treenix__execute:$schema',
  ],
  deny: [
    'mcp__treenix__guardian_approve',
    // Guardian subtree is the gate itself — no agent may rewrite policy or
    // resolve its own approvals through generic tools (deny survives any merge).
    'mcp__treenix__set_node:/guardian*',
    'mcp__treenix__remove_node:/guardian*',
    'mcp__treenix__execute:*:/guardian*',
    'Bash:git checkout *', 'Bash:git checkout -- *',
    'Bash:git reset --hard*', 'Bash:git push --force*', 'Bash:git clean*',
    'Bash:rm -rf *', 'Bash:rm -r *', 'Bash:cat *.env*',
  ],
  escalate: ['mcp__treenix__set_node', 'mcp__treenix__execute:*', 'mcp__treenix__remove_node'],
};

// ── Convert ai.policy node data → runtime ToolPolicy ──

function policyFromNode(p: AiPolicy): ToolPolicy {
  return {
    allow: [...p.allow],
    deny: [...p.deny],
    escalate: [...p.escalate],
  };
}

/** Merge two policies: override can relax escalate→allow, but NEVER cancel deny.
 * Deny is authoritative — once denied by base, agent-local allow cannot override. */
function mergePolicies(base: ToolPolicy, override: ToolPolicy): ToolPolicy {
  const allow = [...new Set([...base.allow, ...override.allow])];
  const deny = [...new Set([...base.deny, ...override.deny])];
  const escalate = [...new Set([...base.escalate, ...override.escalate])];
  // Override allow can relax escalate (ask→allow), but never cancel deny
  const cleanEscalate = escalate.filter(t => !override.allow.includes(t));
  return {
    allow,
    deny,
    escalate: cleanEscalate,
  };
}

const GUARDIAN_PATH = '/guardian';

/** Resolve policy cascade: agent → global → fallback.
 *  An ABSENT node/component is normal (fallback applies). A READ ERROR or a
 *  malformed policy is NOT — it propagates, and the caller denies everything
 *  (fail closed, core-1prz). Swallowing it here silently degraded the gate. */
async function resolvePolicy(store: Tree, agentPath: string): Promise<ToolPolicy> {
  const hardcoded = FALLBACK_POLICY;

  let base = hardcoded;
  const guardianNode = await store.get(GUARDIAN_PATH);
  if (guardianNode) {
    const globalPolicy = getComponent(guardianNode, AiPolicy);
    if (globalPolicy && (globalPolicy.allow.length || globalPolicy.deny.length || globalPolicy.escalate.length)) {
      base = mergePolicies(hardcoded, policyFromNode(globalPolicy));
    }
  }

  const agentNode = await store.get(agentPath);
  if (agentNode) {
    const agentPolicy = getComponent(agentNode, AiPolicy);
    if (agentPolicy && (agentPolicy.allow.length || agentPolicy.deny.length || agentPolicy.escalate.length)) {
      return mergePolicies(base, policyFromNode(agentPolicy));
    }
  }

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


// ── Always-deny bash patterns (non-negotiable safety net) ──

const DANGEROUS_BASH = [
  /rm\s+-rf/, /push\s+--force/, /reset\s+--hard/, /--no-verify/,
  /curl\b.*\|\s*(?:ba)?sh/, /wget\b.*\|\s*(?:ba)?sh/,   // pipe-to-shell
  /\beval\s+/,                                             // arbitrary eval
  /chmod\s+777/, /chmod\s+\+s/,                            // permission escalation
  /\bdd\s+.*of=\/dev\//, /\bmkfs\b/,                      // disk destruction
];

// ── Shell metacharacter detection ──
// Commands containing these are not safe for word-based classification —
// they can embed arbitrary sub-commands or redirect output.

const SHELL_META_RE = /[`$]|\$\(|[<>]|[|]{2}|[&]{2}/;

/** Returns true if the sub-command contains shell metacharacters that could
 *  embed or redirect arbitrary commands (backticks, $(), redirections). */
export function hasShellMeta(cmd: string): boolean {
  // Only strip single-quoted strings — double quotes still expand $ and backticks in shell
  const stripped = cmd.replace(/'[^']*'/g, '');
  return SHELL_META_RE.test(stripped);
}

// ── Bash command classification ──

const BASH_AUTO = new Set([
  'cd', 'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'which',
  'grep', 'find', 'rg', 'tree', 'du', 'df', 'echo', 'printf', 'date', 'uname',
  'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote',
  'npm ls', 'npm info', 'npm view',
]);

const BASH_SESSION = new Set([
  'mkdir', 'touch', 'cp', 'mv',
  'npm test', 'tsc',
  'node', 'tsx', 'npx', 'npm run',
  'git add', 'git commit', 'git stash', 'git fetch', 'git pull',
  'npm install', 'npm ci', 'npm update',
]);

const BASH_ESCALATE = new Set([
  'git push', 'git merge', 'git rebase', 'git tag',
  'npm publish',
  'docker',
]);

export function classifyBashCommand(cmd: string): 'auto' | 'session' | 'escalate' | 'unknown' {
  const trimmed = cmd.trim();

  // Shell metacharacters bypass word-based classification → always unknown
  if (hasShellMeta(trimmed)) return 'unknown';

  const words = trimmed.split(/\s+/);
  const twoWord = words.slice(0, 2).join(' ');
  const oneWord = words[0];

  if (BASH_AUTO.has(twoWord) || BASH_AUTO.has(oneWord)) return 'auto';
  if (BASH_SESSION.has(twoWord) || BASH_SESSION.has(oneWord)) return 'session';
  if (BASH_ESCALATE.has(twoWord) || BASH_ESCALATE.has(oneWord)) return 'escalate';
  return 'unknown';
}

/** Coarse cache key for session approval: Bash:{twoWord} or Bash:{oneWord} */
function bashCacheKey(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  const twoWord = words.slice(0, 2).join(' ');
  if (BASH_AUTO.has(twoWord) || BASH_SESSION.has(twoWord) || BASH_ESCALATE.has(twoWord)) {
    return `Bash:${twoWord}`;
  }
  return `Bash:${words[0]}`;
}

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
      if (ch === '&') { parts.push(cur); cur = ''; continue; }  // background operator
      if (ch === ';') { parts.push(cur); cur = ''; continue; }
    }

    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

// ── Escalation via tree nodes ──
// The approval's entire fate lives in the ai.approval NODE — status, expiresAt,
// remember — no in-memory resolver, so pending approvals survive restarts
// (gk8.7): approve/deny actions only mutate the node; waiters POLL it; a
// resumed agent re-requesting the same (agentPath, tool, input) re-attaches to
// the still-pending node instead of duplicating it. Polling is a cache-backed
// get at human-scale traffic and keeps guardian decoupled from the sub/ layer;
// switch to a node watch when the transport-neutral watch API settles (gk8.25).

const APPROVAL_TIMEOUT = 60 * 60 * 1000; // 1 hour
const APPROVAL_POLL_MS = 2_000;

/** Test seam: production callers use the defaults. */
export type ApprovalWait = { timeoutMs?: number; pollMs?: number };

function approvalDeadline(node: NodeData): number {
  return typeof node.expiresAt === 'number' && node.expiresAt > 0
    ? node.expiresAt
    : (Number(node.createdAt) || 0) + APPROVAL_TIMEOUT;
}

export async function requestApproval(
  store: Tree,
  opts: { agentPath: string; role: string; tool: string; input: string; reason: string },
  wait: ApprovalWait = {},
): Promise<boolean> {
  const timeoutMs = wait.timeoutMs ?? APPROVAL_TIMEOUT;
  const pollMs = wait.pollMs ?? APPROVAL_POLL_MS;
  const input = opts.input.slice(0, 4000);

  // Re-attach after a restart: the resumed agent retries its tool call and must
  // latch onto the approval the human may already be looking at.
  const { items } = await store.getChildren('/guardian/approvals');
  const existing = items.find(n => n.$type === 'ai.approval' && n.status === 'pending'
    && n.agentPath === opts.agentPath && n.tool === opts.tool && n.input === input);

  let path: string;
  if (existing) {
    path = existing.$path;
    console.log(`[guardian] re-attached to pending escalation: ${path}`);
  } else {
    path = `/guardian/approvals/a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await store.set(createNode(path, 'ai.approval', {
      agentPath: opts.agentPath,
      agentRole: opts.role,
      tool: opts.tool,
      input,
      inputTruncated: opts.input.length > 4000,
      status: 'pending',
      reason: opts.reason,
      createdAt: Date.now(),
      resolvedAt: 0,
      expiresAt: Date.now() + timeoutMs,
    }));
    console.log(`[guardian] escalation: ${opts.role} wants ${opts.tool} → ${path}`);
  }

  for (;;) {
    const node = await store.get(path);
    if (!node) {
      console.error(`[guardian] approval node vanished mid-wait, denying: ${path}`);
      return false;
    }

    if (node.status === 'approved' || node.status === 'denied') {
      const allow = node.status === 'approved';
      const remember = node.remember;
      if (remember === 'agent' || remember === 'global') {
        try {
          await rememberRule(store, String(node.tool), String(node.input), allow, String(node.agentPath), remember);
        } catch (err) {
          console.error(`[guardian] failed to persist rule: ${err}`);
        }
      }
      return allow;
    }

    if (Date.now() >= approvalDeadline(node)) {
      try {
        await store.set({ ...node, status: 'denied' as const, reason: 'timeout', resolvedAt: Date.now() });
      } catch (err) {
        // OCC conflict = a human resolved it concurrently — loop re-reads and honors that.
        if (err instanceof KernelError && err.code === 'CONFLICT') continue;
        throw err;
      }
      console.log(`[guardian] escalation timed out: ${path}`);
      return false;
    }

    await new Promise(r => setTimeout(r, pollMs));
  }
}

/** Write a persistent rule to agent or global policy (with OCC retry) */
export async function rememberRule(store: Tree, tool: string, _input: string, allow: boolean, agentPath: string, scope: string) {
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
      if (err instanceof KernelError && err.code === 'CONFLICT' && attempt < MAX_RETRIES - 1) {
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

  // Expire only approvals past their deadline — fresh pendings SURVIVE restart
  // (gk8.7): resumed agents re-attach via requestApproval, humans resolve via
  // the node's approve/deny actions; nothing depends on in-process state.
  const { items } = await store.getChildren('/guardian/approvals');
  for (const approval of items) {
    if (approval.$type !== 'ai.approval' || approval.status !== 'pending') continue;
    if (Date.now() < approvalDeadline(approval)) continue;
    await store.set({ ...approval, status: 'denied' as const, reason: 'expired', resolvedAt: Date.now() });
    console.log(`[guardian] expired stale approval: ${approval.$path}`);
  }

  // Reconcile agents — resume those with sessionId, reset the rest
  const resumablePaths: string[] = [];

  async function reconcileAgentNode(node: NodeData) {
    const agent = getComponent(node, AiAgent);
    if (!agent || (agent.status !== 'working' && agent.status !== 'blocked')) return;

    const chat = getComponent(node, AiChat);
    const hasSession = chat && typeof chat.sessionId === 'string' && chat.sessionId.length > 0;
    const taskPath = typeof agent.currentTask === 'string' ? agent.currentTask : '';

    if (hasSession && taskPath) {
      resumable.push({ agentPath: node.$path, taskPath });
      resumablePaths.push(node.$path);
      console.log(`[guardian] resumable agent: ${node.$path} → ${taskPath} (session ${chat.sessionId.slice(0, 8)}...)`);
    } else {
      agent.status = 'idle';
      agent.currentTask = '';
      agent.currentRun = '';
      await store.set(node);
      console.log(`[guardian] reset stuck agent: ${node.$path}`);

      try {
        const { items: runs } = await store.getChildren(`${node.$path}/runs`);
        for (const run of runs) {
          if (run.$type !== 'ai.run') continue;
          const runStatus = getComponent(run, AiRunStatus);
          if (!runStatus || runStatus.status !== 'running') continue;
          runStatus.status = 'error';
          runStatus.error = 'interrupted: server restart';
          await store.set(run);
          console.log(`[guardian] reset stuck agent run: ${run.$path}`);
        }
      } catch { /* no runs dir yet */ }
    }
  }

  // Scan /agents (standard agent nodes)
  try {
    const { items } = await store.getChildren('/agents');
    for (const node of items) {
      if (node.$type !== 'ai.agent') continue;
      await reconcileAgentNode(node);
    }
  } catch { /* */ }

  // Scan /org (org.post nodes with ai.agent components)
  try {
    const { items: divisions } = await store.getChildren('/org');
    for (const div of divisions) {
      if (div.$type !== 'org.division') continue;
      const { items: posts } = await store.getChildren(div.$path);
      for (const post of posts) {
        if (post.$type === 'org.post' && getComponent(post, AiAgent)) {
          await reconcileAgentNode(post);
        }
      }
    }
  } catch { /* org tree may not exist */ }

  // Update pool — keep resumable agents in active, clear the rest
  try {
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

// ── Classification priority: deny > escalate > session > auto ──

const CLASS_PRIORITY: Record<ReturnType<typeof classifyBashCommand>, number> = {
  auto: 0,
  session: 1,
  escalate: 2,
  unknown: 3,
};

// ── canUseTool callback for Agent SDK ──

// Read-only tools that plan mode is allowed to use
const READ_ONLY_TOOLS = new Set([
  'mcp__treenix__get_node', 'mcp__treenix__list_children',
  'mcp__treenix__catalog', 'mcp__treenix__describe_type',
  'mcp__treenix__search_types',
]);

const READ_ONLY_BASH = new Set([
  'cat', 'head', 'tail', 'ls', 'pwd', 'wc', 'file', 'which',
  'grep', 'find', 'rg', 'tree', 'du', 'df', 'echo', 'date', 'uname',
  'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote',
  'npm ls', 'npm info', 'npm view',
]);

export function createCanUseTool(
  role: string,
  agentPath: string,
  store?: Tree,
  opts?: {
    readOnly?: boolean;
    /** Branch path the run is rooted into. Tool args carry VIEW paths ('/x'
     *  means <branch>/tree/x, '/.branch' means the branch node) — translate
     *  them to REAL paths before policy evaluation, so path-scoped rules
     *  (allow set_node:/branches/*, escalate execute:merge:/branches/*)
     *  judge the actual write target. */
    branchRoot?: string;
    /** Test seam — poll/timeout overrides for requestApproval. */
    approvalWait?: ApprovalWait;
  },
) {
  const allow = (): PermissionResult => ({ behavior: 'allow' });
  const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });

  // Cache resolved policy (per agent run)
  let cachedPolicy: ToolPolicy | null = null;

  // Session-level approval cache — persists for the duration of one task run
  const sessionApproved = new Map<string, boolean>();

  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {

    // Lazy-resolve policy from tree on first call. Resolution failure (store
    // error, malformed policy component) denies THIS call without caching —
    // a transient store error recovers on the next call, never degrades to
    // the fallback silently (fail closed, core-1prz).
    if (!cachedPolicy) {
      try {
        cachedPolicy = store
          ? await resolvePolicy(store, agentPath)
          : FALLBACK_POLICY;
      } catch (err) {
        console.error(`[guardian] policy resolution failed for ${role}@${agentPath} — denying:`, err);
        return deny(`${role}: guardian policy unreadable — fail closed`);
      }
      console.log(`[guardian] resolved policy for ${role}@${agentPath}: allow=${cachedPolicy.allow.length} deny=${cachedPolicy.deny.length} escalate=${cachedPolicy.escalate.length}`);
    }
    const policy = cachedPolicy;

    console.log(`[guardian] canUseTool: ${toolName} → deny=${matchesAny(policy.deny, toolName)} allow=${matchesAny(policy.allow, toolName)} escalate=${matchesAny(policy.escalate, toolName)}`);

    // Deny-list check first (bare tool name)
    if (matchesAny(policy.deny, toolName)) {
      return deny(`${role}: denied: ${toolName}`);
    }

    // Read-only mode for non-Bash tools — restrict to whitelist AFTER deny check
    // Path-scoped denies (e.g. get_node:/secret/*) are evaluated in compound section below
    if (opts?.readOnly && toolName !== 'Bash') {
      if (!READ_ONLY_TOOLS.has(toolName)) {
        return deny(`Plan mode: read-only. "${toolName}" is not allowed.`);
      }
      // Don't return allow() here — fall through to compound deny check below
    }

    // Bash → safety net, then classify each sub-command
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

      // Split into sub-commands and classify each
      const parts = lines.length > 0 ? lines.flatMap(l => splitBashParts(l)) : [];
      if (parts.length === 0) return deny(`${role}: empty bash command`);

      // Early reject: shell metacharacters in any sub-command → deny with guidance
      for (const part of parts) {
        if (hasShellMeta(part)) {
          return deny(
            `Shell metacharacters are not allowed in commands. ` +
            `No $(), backticks, $VAR, or redirections (>, <). ` +
            `Run each command directly. To write files use the Write tool, not shell redirections.`,
          );
        }
      }

      // Evaluate each sub-command independently via policy, take strictest verdict.
      // deny > escalate > null > allow — one denied part denies all, one escalated part
      // escalates all, one unmatched part (null) prevents blanket allow.
      let strictVerdict: 'allow' | 'escalate' | 'deny' | null = null;
      let allExplicit = true;
      let escalatedSubject = '';

      for (const part of parts) {
        const subject = `Bash:${part.trim()}`;
        const v = resolveVerdict(policy, [subject]);

        if (v === 'deny') return deny(`${role}: denied: ${subject}`);
        if (v === 'escalate') {
          strictVerdict = 'escalate';
          if (!escalatedSubject) escalatedSubject = subject;
        } else if (v === null) {
          allExplicit = false; // at least one part not covered by policy
        }
        // allow → fine, but only if ALL parts are explicit
      }

      // Read-only Bash: after deny checks, only allow whitelisted read commands
      if (opts?.readOnly) {
        for (const part of parts) {
          const words = part.trim().split(/\s+/);
          const twoWord = words.slice(0, 2).join(' ');
          if (!READ_ONLY_BASH.has(twoWord) && !READ_ONLY_BASH.has(words[0])) {
            return deny(`Plan mode: read-only. "${words[0]}" is not allowed. Only read commands (ls, cat, grep, git status, etc).`);
          }
        }
        return allow();
      }

      if (strictVerdict === 'escalate') {
        const cached = sessionApproved.get(escalatedSubject);
        if (cached !== undefined) return cached ? allow() : deny('session-denied');
        if (!store) return deny(`${role}: not allowed: ${escalatedSubject}`);
        const approved = await requestApproval(store, {
          agentPath, role, tool: escalatedSubject, input: cmd,
          reason: 'policy escalation',
        }, opts?.approvalWait);
        sessionApproved.set(escalatedSubject, approved);
        return approved ? allow() : deny('denied by human');
      }

      // Only blanket-allow if every part was explicitly allowed by policy
      if (strictVerdict !== 'escalate' && allExplicit) return allow();

      // Fallback: classify each sub-command
      let strictest: ReturnType<typeof classifyBashCommand> = 'auto';
      let strictestPart = parts[0];
      for (const part of parts) {
        const cls = classifyBashCommand(part);
        if (CLASS_PRIORITY[cls] > CLASS_PRIORITY[strictest]) {
          strictest = cls;
          strictestPart = part;
        }
      }

      // auto → allow immediately
      if (strictest === 'auto') return allow();

      // session, escalate, unknown → check session cache (coarse key), then escalate to human
      const coarseKey = bashCacheKey(strictestPart);
      const cached = sessionApproved.get(coarseKey);
      if (cached !== undefined) return cached ? allow() : deny('session-denied');

      if (!store) return deny(`${role}: not allowed: ${coarseKey}`);

      const approved = await requestApproval(store, {
        agentPath, role, tool: coarseKey, input: cmd,
        reason: strictest === 'unknown' ? 'unknown command' : 'requires approval',
      }, opts?.approvalWait);
      sessionApproved.set(coarseKey, approved);
      return approved ? allow() : deny('denied by human');
    }

    // Non-Bash tools — build ordered subjects (most specific → least)
    // Same format as MCP buildSubjects: tool:action:path, tool:action, tool:path, tool
    const viewToReal = (p: string): string => {
      const root = opts?.branchRoot;
      if (!root || !p.startsWith('/')) return p;
      if (p === '/.branch') return root;
      return `${root}/tree${p === '/' ? '' : p}`;
    };
    const action = typeof input.action === 'string' && input.action ? input.action : null;
    const rawTarget = typeof input.path === 'string' && input.path ? input.path
      : typeof input.target === 'string' && input.target ? input.target : null;
    const target = rawTarget ? viewToReal(rawTarget) : null;
    const subjects: string[] = [];
    if (action && target) subjects.push(`${toolName}:${action}:${target}`);
    if (action) subjects.push(`${toolName}:${action}`);
    if (!action && target) subjects.push(`${toolName}:${target}`);
    subjects.push(toolName);

    // Most specific subject for cache/approval key
    const toolSubject = subjects[0];

    // Resolve verdict via subject-level specificity (deny > escalate > allow per subject)
    const verdict = resolveVerdict(policy, subjects);

    if (verdict === 'deny') {
      const deniedSubject = subjects.find(s => matchesAny(policy.deny, s)) ?? toolName;
      return deny(`${role}: denied: ${deniedSubject}`);
    }

    // Read-only mode: if tool passed deny checks, allow (readOnly whitelist already checked above)
    if (opts?.readOnly) return allow();

    if (verdict === 'allow') return allow();

    if (verdict === 'escalate') {
      const cached = sessionApproved.get(toolSubject);
      if (cached !== undefined) return cached ? allow() : deny('session-denied');

      if (store) {
        const inputStr = JSON.stringify(input);
        const approved = await requestApproval(store, {
          agentPath, role, tool: toolSubject, input: inputStr,
          reason: 'requires approval',
        }, opts?.approvalWait);
        sessionApproved.set(toolSubject, approved);
        return approved ? allow() : deny('denied by human');
      }
      return deny(`${role}: escalated but no store: ${toolName}`);
    }

    // Unknown tool — escalate to human
    const cached = sessionApproved.get(toolSubject);
    if (cached !== undefined) return cached ? allow() : deny('session-denied');

    if (store) {
      const inputStr = JSON.stringify(input);
      const approved = await requestApproval(store, {
        agentPath, role, tool: toolSubject, input: inputStr,
        reason: 'unknown tool',
      }, opts?.approvalWait);
      sessionApproved.set(toolSubject, approved);
      return approved ? allow() : deny('denied by human');
    }
    return deny(`${role}: not allowed: ${toolName}`);
  };
}
