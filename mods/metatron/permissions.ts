// Metatron permission system — rule matching engine: evaluates tree-stored
// rules against tool calls. Approval RESOLUTION lives in the ai.approval node
// itself (mods/agent: status/remember fields, polled by the guardian waiter) —
// the in-memory pendingPermissions resolver map is gone (gk8.7): it died on
// every restart and took overnight approvals with it.
// Separate module to avoid pulling @anthropic-ai/claude-agent-sdk into browser bundle.

export type PermissionPolicy = 'allow' | 'ask-once' | 'ask-always' | 'deny';

export type PermissionRule = {
  tool: string;         // glob pattern: 'mcp__treenix__*', '*'
  pathPattern: string;  // optional input.path pattern
  policy: PermissionPolicy;
};

import { globMatch } from '@treenx/core/glob';

// ── Rule specificity (more specific = higher score) ──

function ruleSpecificity(rule: PermissionRule): number {
  let score = 0;
  // Exact tool name > glob pattern > wildcard
  if (!rule.tool.includes('*')) score += 100;
  else if (rule.tool !== '*') score += 50;
  // Path pattern adds specificity
  if (rule.pathPattern) score += 10;
  return score;
}

// ── Evaluate permission against rules ──

export function evaluatePermission(
  rules: PermissionRule[],
  toolName: string,
  input: unknown,
): PermissionPolicy | null {
  const inputPath = (input && typeof input === 'object' && 'path' in input)
    ? String((input as any).path)
    : '';

  // Find all matching rules
  const matches = rules.filter(r => {
    if (!globMatch(r.tool, toolName)) return false;
    if (r.pathPattern && inputPath && !globMatch(r.pathPattern, inputPath)) return false;
    return true;
  });

  if (!matches.length) return null; // no rule matched — caller decides default

  // Sort by specificity (most specific first), then by deny > ask > allow priority
  const policyPriority: Record<string, number> = { deny: 3, 'ask-always': 2, 'ask-once': 1, allow: 0 };

  matches.sort((a, b) => {
    const specDiff = ruleSpecificity(b) - ruleSpecificity(a);
    if (specDiff !== 0) return specDiff;
    return (policyPriority[b.policy] ?? 0) - (policyPriority[a.policy] ?? 0);
  });

  return matches[0].policy;
}
