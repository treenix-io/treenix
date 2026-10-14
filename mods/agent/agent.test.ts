// Agent Office tests — types (state machine) + guardian (policy registry)

import { createNode, getComponent, compKey } from '@treenx/core';
import { createInstance } from '../../core/src/kernel/instance';
import { createMemoryBlobStore } from '@treenx/core/kernel/blob-store-memory';
import { createMemoryStore } from '@treenx/core/kernel/store/memory';
import type { Position } from '@treenx/core/kernel/types';
import { nativeAgentTypes } from './native-manifest';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import './types';
import {
  buildPermissionRules,
  classifyBashCommand,
  resolveVerdict,
  splitBashParts,
} from './guardian';
import {
  AiAgent,
  AiAssignment,
  AiCost,
  AiLog,
  AiPlan,
  AiPolicy,
  AiPool,
  AiRun,
  AiRunStatus,
  type ThreadMessage,
} from './types';

const manifest = {
  id: 'agent-contract',
  types: nativeAgentTypes('agent-contract'),
  security: [],
  open: [],
};
let instance: Awaited<ReturnType<typeof createInstance>>;
let commands: ReturnType<typeof instance.commands>;
let sequence = 0;

before(async () => {
  const root = createMemoryStore({ domain: 'agent-contract' });
  let saved: Position | undefined;
  instance = await createInstance({
    id: 'agent-contract',
    root: { kind: 'store', store: root },
    modules: [manifest],
    blobs: createMemoryBlobStore(),
    provisioning: {
      writerEpoch: 1,
      credentialTtlMs: 60_000,
      counter: {
        async load() {
          return saved;
        },
        async save(value) {
          saved = value;
        },
        async freshEpoch(floor) {
          return floor + 1;
        },
      },
      domains: [{ store: root, epoch: 'agent-contract1', persistent: false }],
      bootstrap: {
        kind: 'fresh',
        admin: { path: '/admin', name: 'admin', password: 'agent-contract-password' },
      },
    },
  });
  assert.ok(instance.setupCredential);
  commands = instance.commands(await instance.auth.openCredential(instance.setupCredential));
});

after(() => instance.close());

/** Exercise the real native draft and copy its accepted data back to the existing fixture assertions. */
async function callAction(
  node: ReturnType<typeof createNode>,
  action: string,
  args: unknown = {},
  component?: string,
) {
  // The fixture copies accepted nodes back for assertions; writes omit issued metadata.
  const { $owner, $id, $rev, ...input } = node;
  const key = () => ({
    epoch: instance.writer.intake.epoch,
    time: Date.now(),
    nonce: String(++sequence),
  });
  await commands.commit({ opId: key(), changes: [{ op: 'put', node: input }] });
  await commands.act({
    path: node.$path,
    action,
    args,
    opId: key(),
    ...(component === undefined ? {} : { component: compKey(component) }),
  });
  const accepted = await instance.source.node(node.$path);
  assert.ok(accepted);
  if (component === undefined) Object.assign(node, accepted);
  else Object.assign(getComponent(node, 'ai.plan')!, getComponent(accepted, 'ai.plan')!);
}

// ── AiAgent state machine (via action handlers) ──

describe('AiAgent', () => {
  function makeAgent(overrides?: Partial<AiAgent>) {
    return createNode('/agents/test', 'ai.agent', {
      model: 'claude-opus-4-6',
      systemPrompt: '',
      role: 'qa',
      status: 'offline',
      currentTask: '',
      currentRun: '',
      lastRunAt: 0,
      totalTokens: 0,
      ...overrides,
    });
  }

  it('online() transitions offline → idle', async () => {
    const node = makeAgent({ status: 'offline' });
    await callAction(node, 'online');
    assert.equal(node.status, 'idle');
  });

  it('offline() transitions idle → offline', async () => {
    const node = makeAgent({ status: 'idle' });
    await callAction(node, 'offline');
    assert.equal(node.status, 'offline');
  });

  it('offline() throws when working', async () => {
    const node = makeAgent({ status: 'working' });
    await assert.rejects(
      () => callAction(node, 'offline'),
      (e: Error) => e.message.includes('cannot'),
    );
  });

  it('assign() transitions idle → working with task', async () => {
    const node = makeAgent({ status: 'idle' });
    await callAction(node, 'assign', { task: '/board/data/task-1' });
    assert.equal(node.status, 'working');
    assert.equal(node.currentTask, '/board/data/task-1');
  });

  it('assign() throws when not idle', async () => {
    const node = makeAgent({ status: 'working' });
    await assert.rejects(
      () => callAction(node, 'assign', { task: '/board/data/x' }),
      (e: Error) => e.message.includes('cannot'),
    );
  });

  it('assign() throws on empty task', async () => {
    const node = makeAgent({ status: 'idle' });
    await assert.rejects(
      () => callAction(node, 'assign', { task: '' }),
      (e: Error) => e.message.includes('task'),
    );
  });

  it('complete() transitions working → idle', async () => {
    const node = makeAgent({ status: 'working', currentTask: '/board/data/t' });
    await callAction(node, 'complete');
    assert.equal(node.status, 'idle');
    assert.equal(node.currentTask, '');
    assert.ok(node.lastRunAt > 0);
  });

  it('complete() throws when not working', async () => {
    const node = makeAgent({ status: 'idle' });
    await assert.rejects(
      () => callAction(node, 'complete'),
      (e: Error) => e.message.includes('cannot'),
    );
  });

  it('block() sets status to blocked', async () => {
    const node = makeAgent({ status: 'working' });
    await callAction(node, 'block');
    assert.equal(node.status, 'blocked');
  });

  it('fail() sets status to error and clears task', async () => {
    const node = makeAgent({ status: 'working', currentTask: '/board/data/t' });
    await callAction(node, 'fail');
    assert.equal(node.status, 'error');
    assert.equal(node.currentTask, '');
  });

  it('declares all expected native actions', () => {
    for (const action of ['online', 'offline', 'assign', 'complete', 'block', 'fail']) {
      assert.ok(
        manifest.types.find((type) => type.name === 'ai.agent')!.actions[action],
        `missing action:${action}`,
      );
    }
  });
});

// ── AiThread ──

describe('AiThread', () => {
  it('post() action adds message', async () => {
    const node = createNode('/tasks/t1', 'ai.thread', { messages: [] as ThreadMessage[] });
    assert.ok(manifest.types.find((type) => type.name === 'ai.thread')!.actions.post);
    await callAction(node, 'post', { role: 'qa', from: '/agents/qa', text: 'looks good' });
    assert.equal(node.messages.length, 1);
    assert.equal(node.messages[0].role, 'qa');
    assert.ok(node.messages[0].ts > 0);
  });

  it('post() throws on empty text', async () => {
    const node = createNode('/tasks/t1', 'ai.thread', { messages: [] as ThreadMessage[] });
    await assert.rejects(
      () => callAction(node, 'post', { role: 'qa', from: '/agents/qa', text: '' }),
      (e: Error) => e.message.includes('empty'),
    );
  });
});

// ── Guardian — fallback policy + buildPermissionRules ──

describe('Guardian', () => {
  it('buildPermissionRules produces ask-once and allow rules from fallback', () => {
    const rules = buildPermissionRules('any-role');
    assert.ok(rules.some((r) => r.policy === 'ask-once'));
    assert.ok(rules.some((r) => r.policy === 'allow'));
    assert.ok(rules.some((r) => r.tool === 'mcp__treenix__remove_node' && r.policy === 'ask-once'));
    assert.ok(rules.some((r) => r.tool === 'mcp__treenix__get_node' && r.policy === 'allow'));
  });
});

// ── classifyBashCommand ──

describe('classifyBashCommand', () => {
  it('classifies auto commands', () => {
    assert.equal(classifyBashCommand('ls -la'), 'auto');
    assert.equal(classifyBashCommand('cat /etc/hosts'), 'auto');
    assert.equal(classifyBashCommand('git status'), 'auto');
    assert.equal(classifyBashCommand('git diff --cached'), 'auto');
    assert.equal(classifyBashCommand('npm test'), 'session');
    assert.equal(classifyBashCommand('npm run build'), 'session');
    assert.equal(classifyBashCommand('node index.js'), 'session');
    assert.equal(classifyBashCommand('tsx script.ts'), 'session');
    assert.equal(classifyBashCommand('echo hello'), 'auto');
  });

  it('classifies session commands', () => {
    assert.equal(classifyBashCommand('mkdir -p src/new'), 'session');
    assert.equal(classifyBashCommand('cp file.ts backup.ts'), 'session');
    assert.equal(classifyBashCommand('mv old.ts new.ts'), 'session');
    assert.equal(classifyBashCommand('git add .'), 'session');
    assert.equal(classifyBashCommand('git commit -m "fix"'), 'session');
    assert.equal(classifyBashCommand('git pull --rebase'), 'session');
    assert.equal(classifyBashCommand('npm install lodash'), 'session');
  });

  it('classifies escalate commands', () => {
    assert.equal(classifyBashCommand('git push origin main'), 'escalate');
    assert.equal(classifyBashCommand('git merge feature'), 'escalate');
    assert.equal(classifyBashCommand('git rebase main'), 'escalate');
    assert.equal(classifyBashCommand('npm publish'), 'escalate');
    assert.equal(classifyBashCommand('docker run nginx'), 'escalate');
  });

  it('classifies unknown commands', () => {
    assert.equal(classifyBashCommand('curl https://example.com'), 'unknown');
    assert.equal(classifyBashCommand('python3 script.py'), 'unknown');
    assert.equal(classifyBashCommand('some-custom-tool --flag'), 'unknown');
  });

  it('shell metacharacters → unknown (prevents bypass)', () => {
    // $() can embed arbitrary commands
    assert.equal(classifyBashCommand('echo $(git push origin main)'), 'unknown');
    // Backticks can embed arbitrary commands
    assert.equal(classifyBashCommand('echo `git push origin main`'), 'unknown');
    // Redirections can exfiltrate data
    assert.equal(classifyBashCommand('cat /etc/passwd > /tmp/leak'), 'unknown');
    // Quoted metacharacters are safe — they're literal strings
    assert.equal(classifyBashCommand('echo "hello $world"'), 'unknown');
    assert.equal(classifyBashCommand("echo 'safe $(no-exec)'"), 'auto');
  });

  it('two-word match takes priority over one-word', () => {
    // 'git status' matches BASH_AUTO even though 'git' alone is not in any set
    assert.equal(classifyBashCommand('git status --short'), 'auto');
    // 'git push' matches BASH_ESCALATE
    assert.equal(classifyBashCommand('git push -u origin feat'), 'escalate');
  });
});

// ── splitBashParts ──

describe('splitBashParts', () => {
  it('splits by pipe', () => {
    assert.deepEqual(splitBashParts('ls /foo | head -10'), ['ls /foo', 'head -10']);
  });

  it('splits by &&', () => {
    assert.deepEqual(splitBashParts('npm install && npm test'), ['npm install', 'npm test']);
  });

  it('splits by bare & (background operator)', () => {
    assert.deepEqual(splitBashParts('ls & git push origin main'), ['ls', 'git push origin main']);
  });

  it('splits by || and ;', () => {
    assert.deepEqual(splitBashParts('cmd1 || cmd2 ; cmd3'), ['cmd1', 'cmd2', 'cmd3']);
  });

  it('respects double quotes', () => {
    assert.deepEqual(splitBashParts('echo "hello | world" | head'), [
      'echo "hello | world"',
      'head',
    ]);
  });

  it('respects single quotes', () => {
    assert.deepEqual(splitBashParts("echo 'a && b' && ls"), ["echo 'a && b'", 'ls']);
  });

  it('handles escaped quotes', () => {
    assert.deepEqual(splitBashParts('echo "it\\"s | fine" | wc'), ['echo "it\\"s | fine"', 'wc']);
  });

  it('returns single command as-is', () => {
    assert.deepEqual(splitBashParts('npm test --verbose'), ['npm test --verbose']);
  });

  it('handles empty input', () => {
    assert.deepEqual(splitBashParts(''), []);
  });

  it('handles redirects (not split)', () => {
    assert.deepEqual(splitBashParts('ls /foo 2>/dev/null | head'), ['ls /foo 2>/dev/null', 'head']);
  });
});

// ── Fail-closed: wildcards never grant mutations (core-1prz) ──

describe('fail-closed mutating verdicts (core-1prz)', () => {
  it('tool-segment wildcard allow does not grant mutating tools', () => {
    const p = { allow: ['mcp__treenix__*'], deny: [], escalate: [] };
    assert.equal(resolveVerdict(p, ['mcp__treenix__set_node:/x', 'mcp__treenix__set_node']), null);
    assert.equal(
      resolveVerdict(p, ['mcp__treenix__remove_node:/x', 'mcp__treenix__remove_node']),
      null,
    );
    assert.equal(
      resolveVerdict(p, [
        'mcp__treenix__execute:run:/x',
        'mcp__treenix__execute:run',
        'mcp__treenix__execute',
      ]),
      null,
    );
    assert.equal(
      resolveVerdict(p, ['mcp__treenix__get_node:/x', 'mcp__treenix__get_node']),
      'allow',
    );
  });

  it('bare * grants reads only', () => {
    const p = { allow: ['*'], deny: [], escalate: [] };
    assert.equal(resolveVerdict(p, ['mcp__treenix__set_node:/x', 'mcp__treenix__set_node']), null);
    assert.equal(resolveVerdict(p, ['mcp__treenix__catalog']), 'allow');
  });

  it('wildcard allow + explicit escalate → mutation escalates', () => {
    const p = { allow: ['mcp__treenix__*'], deny: [], escalate: ['mcp__treenix__set_node'] };
    assert.equal(
      resolveVerdict(p, ['mcp__treenix__set_node:/x', 'mcp__treenix__set_node']),
      'escalate',
    );
  });

  it('tool-literal allows still grant — scoping by path/action stays free', () => {
    const p = {
      allow: ['mcp__treenix__set_node:/branches/*', 'mcp__treenix__execute:*'],
      deny: [],
      escalate: [],
    };
    assert.equal(
      resolveVerdict(p, ['mcp__treenix__set_node:/branches/b1', 'mcp__treenix__set_node']),
      'allow',
    );
    assert.equal(
      resolveVerdict(p, ['mcp__treenix__set_node:/live/x', 'mcp__treenix__set_node']),
      null,
    );
    assert.equal(
      resolveVerdict(p, [
        'mcp__treenix__execute:run:/x',
        'mcp__treenix__execute:run',
        'mcp__treenix__execute',
      ]),
      'allow',
    );
  });
});

// ── AiPlan ──

describe('AiPlan', () => {
  it('approvePlan sets approved flag', async () => {
    const node = createNode('/board/data/t1', 't.dir', undefined, {
      plan: {
        $type: 'ai.plan',
        text: 'Step 1: do X\nStep 2: do Y',
        approved: false,
        feedback: '',
        createdAt: Date.now(),
      },
    });
    const plan = getComponent(node, AiPlan)!;
    assert.ok(plan);
    assert.equal(plan.approved, false);

    await callAction(node, 'approvePlan', {}, 'plan');
    assert.equal(plan.approved, true);
  });

  it('approvePlan with feedback', async () => {
    const node = createNode('/board/data/t1', 't.dir', undefined, {
      plan: {
        $type: 'ai.plan',
        text: 'Some plan',
        approved: false,
        feedback: '',
        createdAt: Date.now(),
      },
    });
    const plan = getComponent(node, AiPlan)!;
    await callAction(node, 'approvePlan', { feedback: 'Also handle edge case X' }, 'plan');
    assert.equal(plan.approved, true);
    assert.equal(plan.feedback, 'Also handle edge case X');
  });

  it('rejectPlan keeps text for re-planning and saves feedback', async () => {
    const node = createNode('/board/data/t1', 't.dir', undefined, {
      plan: {
        $type: 'ai.plan',
        text: 'Bad plan',
        approved: false,
        feedback: '',
        createdAt: Date.now(),
      },
    });
    const plan = getComponent(node, AiPlan)!;
    await callAction(node, 'rejectPlan', { feedback: 'Too risky, simplify' }, 'plan');
    assert.equal(plan.text, 'Bad plan', 'text preserved for agent to see what was rejected');
    assert.equal(plan.approved, false);
    assert.equal(plan.feedback, 'Too risky, simplify');
  });

  it('approvePlan throws on empty plan', async () => {
    const node = createNode('/board/data/t1', 't.dir', undefined, {
      plan: { $type: 'ai.plan', text: '', approved: false, feedback: '', createdAt: 0 },
    });

    await assert.rejects(
      () => callAction(node, 'approvePlan', {}, 'plan'),
      (e: Error) => e.message.includes('no plan'),
    );
  });
});

// ── AiPool ──

describe('AiPool', () => {
  it('creates with default values', () => {
    const node = createNode('/agents', 'ai.pool', { maxConcurrent: 2, active: [], queue: [] });
    const pool = getComponent(node, AiPool)!;
    assert.equal(pool.maxConcurrent, 2);
    assert.deepEqual(pool.active, []);
  });
});

// ── AiAssignment ──

describe('AiAssignment', () => {
  it('creates with defaults', () => {
    const node = createNode('/tasks/t1', 'ai.assignment', {
      origin: '/agents/ceo',
      nextRoles: ['dev', 'qa'],
      cursors: {},
    });
    const asgn = getComponent(node, AiAssignment)!;
    assert.equal(asgn.origin, '/agents/ceo');
    assert.deepEqual(asgn.nextRoles, ['dev', 'qa']);
  });
});

// ── New observability types ──

describe('AiRun', () => {
  it('creates with ECS components', () => {
    const node = createNode(
      '/agents/qa/runs/r-1',
      'ai.run',
      {
        prompt: 'Fix the bug',
        result: '',
        mode: 'work',
        taskRef: '/board/data/task-1',
      },
      {
        log: { $type: 'ai.log', entries: [] },
        'run-status': {
          $type: 'ai.run-status',
          status: 'pending',
          startedAt: 0,
          finishedAt: 0,
          error: '',
        },
        cost: {
          $type: 'ai.cost',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          model: 'claude-sonnet-4-20250514',
        },
      },
    );

    const run = getComponent(node, AiRun)!;
    assert.equal(run.prompt, 'Fix the bug');
    assert.equal(run.mode, 'work');

    const log = getComponent(node, AiLog)!;
    assert.deepEqual(log.entries, []);

    const status = getComponent(node, AiRunStatus)!;
    assert.equal(status.status, 'pending');

    const cost = getComponent(node, AiCost)!;
    assert.equal(cost.costUsd, 0);
    assert.equal(cost.model, 'claude-sonnet-4-20250514');
  });
});

describe('AiPolicy', () => {
  it('creates with empty rule lists', () => {
    const node = createNode('/guardian', 'ai.policy', {
      allow: [],
      deny: [],
      escalate: [],
    });
    const g = getComponent(node, AiPolicy)!;
    assert.deepEqual(g.allow, []);
    assert.deepEqual(g.deny, []);
    assert.deepEqual(g.escalate, []);
  });

  it('addAllow action appends rule', async () => {
    const node = createNode('/guardian', 'ai.policy', { allow: [], deny: [], escalate: [] });
    assert.ok(manifest.types.find((type) => type.name === 'ai.policy')!.actions.addAllow);
    await callAction(node, 'addAllow', { pattern: 'mcp__treenix__*' });
    assert.deepEqual(node.allow, ['mcp__treenix__*']);
  });

  it('addDeny action appends rule', async () => {
    const node = createNode('/guardian', 'ai.policy', { allow: [], deny: [], escalate: [] });
    await callAction(node, 'addDeny', { pattern: 'rm -rf' });
    assert.deepEqual(node.deny, ['rm -rf']);
  });

  it('addEscalate action appends rule', async () => {
    const node = createNode('/guardian', 'ai.policy', { allow: [], deny: [], escalate: [] });
    await callAction(node, 'addEscalate', { pattern: 'git push' });
    assert.deepEqual(node.escalate, ['git push']);
  });

  it('removeRule action removes from correct list', async () => {
    const node = createNode('/guardian', 'ai.policy', {
      allow: ['mcp__treenix__*'],
      deny: ['rm -rf'],
      escalate: ['git push'],
    });
    await callAction(node, 'removeRule', { pattern: 'rm -rf' });
    assert.deepEqual(node.deny, []);
    assert.deepEqual(node.allow, ['mcp__treenix__*'], 'other lists untouched');
  });
});
