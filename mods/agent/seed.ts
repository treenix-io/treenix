// Agent Office seed — /agents pool + agents, /guardian policies

import { registerPrefab } from '@treenx/core/mod';

registerPrefab('agent', 'seed', [
  // Pool node — orchestrator service lives here
  { $path: 'agents', $type: 'ai.pool',
    maxConcurrent: 2, active: [], queue: [] },

  // Guardian — global base policy (applies to ALL agents)
  // Top-level node, not under agents — guardian is data, not a service.
  // Fail closed (core-1prz): reads auto-allow, EVERY mutating tool escalates to a
  // human, the guardian subtree itself is deny — never a blanket mcp__treenix__*.
  // Only admins may edit policy; agents read it (p:1) so views can show the rules.
  { $path: 'guardian', $type: 'ai.policy',
    $acl: [{ g: 'admins', p: 15 }, { g: 'agents', p: 1 }],
    allow: [
      'mcp__treenix__get_node', 'mcp__treenix__list_children',
      'mcp__treenix__catalog', 'mcp__treenix__describe_type',
      'mcp__treenix__search_types',
      'mcp__treenix__execute:$schema',
    ],
    deny: [
      'mcp__treenix__remove_node',
      'mcp__treenix__guardian_approve',
      'mcp__treenix__set_node:/guardian*',
      'mcp__treenix__execute:*:/guardian*',
      'Bash:git checkout *', 'Bash:git checkout -- *',
      'Bash:git reset --hard*', 'Bash:git push --force*', 'Bash:git clean*',
      'Bash:rm -rf *', 'Bash:rm -r *', 'Bash:cat *.env*',
    ],
    escalate: [
      'mcp__treenix__set_node', 'mcp__treenix__execute:*', 'mcp__treenix__deploy_prefab',
      'Bash:git add *', 'Bash:git commit *', 'Bash:git push *',
      'Bash:sed *', 'Bash:mv *', 'Bash:cp *',
    ],
  },

  // Approvals queue — under guardian. Approval inputs may carry other agents'
  // data; agents have no business reading or resolving them (p:0 sticky).
  { $path: 'guardian/approvals', $type: 'ai.approvals',
    $acl: [{ g: 'admins', p: 15 }, { g: 'agents', p: 0 }] },

  // MCP agent identity
  { $path: 'agents/mcp', $type: 'ai.agent',
    role: 'mcp', status: 'idle', currentTask: '', currentRun: '',
    lastRunAt: 0, totalTokens: 0,
    '#policy': {
      $type: 'ai.policy',
      allow: [], deny: [], escalate: [],
    },
  },

  // ── QA agent (ECS: ai.agent + ai.chat + ai.thread) ──
  { $path: 'agents/qa', $type: 'ai.agent',
    role: 'qa',
    status: 'idle',
    model: 'claude-opus-4-6',
    systemPrompt: `You are a QA agent for the Treenix project.
Your job: run tests, check for errors, verify code quality.

## QA Checklist
1. Run \`npm test\` and report results (use Bash tool)
2. Check for TypeScript errors
3. Report any failing tests with details
4. Summarize: PASS (all green) or FAIL (with specifics)

Be concise. Facts only.`,
    currentTask: '',
    currentRun: '',
    lastRunAt: 0,
    totalTokens: 0,
    // '#' keys — bare {$type} values are snapshots, getComponent would not see them
    '#chat': { $type: 'ai.chat', streaming: false, sessionId: '' },
    '#thread': { $type: 'ai.thread', messages: [] },
    '#policy': {
      $type: 'ai.policy',
      allow: ['Bash:npm test*', 'Bash:npm ls*', 'Bash:ls *', 'Bash:cat *', 'Bash:git status*', 'Bash:git diff*', 'Bash:git log*'],
      deny: [],
      escalate: [],
    },
  },
  { $path: 'agents/qa/runs', $type: 'dir' },

  // Autostart — orchestrator starts on server boot
  { $path: '/sys/autostart/agents', $type: 'ref', $ref: '/agents' },
]);
