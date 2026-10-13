// Pure tool-policy resolution and shell command classification.

import { type PermissionRule } from '#metatron/permissions';
import { globMatch, matchesAny } from '@treenx/core/glob';

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

// ── Build metatron-compatible PermissionRule[] ──

/** Describe the static tool policy as SDK permission hints. */
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
