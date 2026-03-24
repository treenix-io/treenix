// Agent Office seed — /agents pool + agents + guardian policies

import { type NodeData } from '@treenity/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('agent', 'seed', [
  // Pool node — orchestrator service lives here
  { $path: 'agents', $type: 'ai.pool',
    maxConcurrent: 2, active: [], queue: [] },

  // Guardian — global base policy (applies to ALL agents)
  // $type: 'ai.policy' so getComponent(node, AiPolicy) returns node itself.
  // Read-only by default. Destructive ops denied. Writes require approval.
  { $path: 'agents/guardian', $type: 'ai.policy',
    allow: [
      'mcp__treenity__get_node', 'mcp__treenity__list_children',
      'mcp__treenity__catalog', 'mcp__treenity__describe_type',
      'mcp__treenity__search_types', 'mcp__treenity__compile_view',
    ],
    deny: [
      'mcp__treenity__remove_node',
      'Bash:git checkout *', 'Bash:git checkout -- *',
      'Bash:git reset --hard*', 'Bash:git push --force*', 'Bash:git clean*',
      'Bash:rm -rf *', 'Bash:rm -r *', 'Bash:cat *.env*',
    ],
    escalate: [
      'mcp__treenity__set_node', 'mcp__treenity__execute', 'mcp__treenity__deploy_prefab',
      'Bash:git add *', 'Bash:git commit *', 'Bash:git push *',
      'Bash:sed *', 'Bash:mv *', 'Bash:cp *',
    ],
  },

  // Approvals queue
  { $path: 'agents/approvals', $type: 'ai.approvals' },

  // ── QA agent (ECS: ai.agent + metatron.config) ──
  { $path: 'agents/qa', $type: 'ai.agent',
    role: 'qa',
    status: 'idle',
    currentTask: '',
    taskRef: '',
    lastRunAt: 0,
    totalTokens: 0,
    // LLM runtime config — metatron.config component (D29)
    config: {
      $type: 'metatron.config',
      model: 'claude-opus-4-6',
      systemPrompt: `You are a QA agent for the Treenity project.
Your job: run tests, check for errors, verify code quality.

## QA Checklist
1. Run \`npm test\` and report results (use Bash tool)
2. Check for TypeScript errors
3. Report any failing tests with details
4. Summarize: PASS (all green) or FAIL (with specifics)

Be concise. Facts only.`,
      sessionId: '',
    },
    // Agent-level policy: only ALLOW overrides (deny/escalate inherited from global guardian)
    policy: {
      $type: 'ai.policy',
      allow: ['Bash:npm *', 'Bash:ls *', 'Bash:cat *', 'Bash:git status*', 'Bash:git diff*', 'Bash:git log*'],
      deny: [],
      escalate: [],
    },
  },
  { $path: 'agents/qa/tasks', $type: 'dir' },

  // Autostart — orchestrator starts on server boot
  { $path: '/sys/autostart/agents', $type: 'ref', $ref: '/agents' },
] as NodeData[]);
