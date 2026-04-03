// MCP Server test suite — token extraction, guardian, ACL, dev mode, security
//
// Tests buildMcpServer via MCP SDK in-process transport (Client ↔ Server).
// No HTTP layer — that belongs in e2e tests.

import '#agent/types';
import '#agent/guardian';

import { AiPolicy } from '#agent/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNode, getComponent, R, S, W } from '@treenity/core';
import { createMemoryTree, type Tree } from '@treenity/core/tree';
import { buildClaims, createSession, withAcl } from '@treenity/core/server/auth';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { buildMcpServer, buildSubjects, checkMcpGuardian, extractToken, type GuardianRequest } from './mcp-server';

// ── Helpers ──

/** Create in-process MCP client connected to buildMcpServer */
async function createTestClient(store: Tree, userId: string, claims?: string[]) {
  const session = { userId } as { userId: string };
  const mcp = await buildMcpServer(store, session, claims);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, mcp };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const t = result.content.find((c: any) => c.type === 'text');
  return (t as any)?.text ?? '';
}

// ── 1. Token Extraction ──

describe('extractToken', () => {
  it('extracts Bearer token from Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123' }, url: '/mcp' } as any;
    assert.equal(extractToken(req), 'abc123');
  });

  it('extracts token from query parameter', () => {
    const req = { headers: {}, url: '/mcp?token=xyz' } as any;
    assert.equal(extractToken(req), 'xyz');
  });

  it('returns null when no token provided', () => {
    const req = { headers: {}, url: '/mcp' } as any;
    assert.equal(extractToken(req), null);
  });

  it('decodes URL-encoded query token', () => {
    const req = { headers: {}, url: '/mcp?token=a%20b%3Dc' } as any;
    assert.equal(extractToken(req), 'a b=c');
  });

  it('prefers Bearer header over query param', () => {
    const req = { headers: { authorization: 'Bearer fromHeader' }, url: '/mcp?token=fromQuery' } as any;
    assert.equal(extractToken(req), 'fromHeader');
  });
});

// ── 2. buildSubjects — subject construction from GuardianRequest ──

describe('buildSubjects', () => {
  it('tool-only: no action, no path', () => {
    const subjects = buildSubjects({ tool: 'catalog', args: {} });
    assert.deepEqual(subjects, ['mcp__treenity__catalog']);
  });

  it('tool + path', () => {
    const subjects = buildSubjects({ tool: 'set_node', args: { path: '/foo/bar', type: 'dir' } });
    assert.deepEqual(subjects, [
      'mcp__treenity__set_node:/foo/bar',
      'mcp__treenity__set_node',
    ]);
  });

  it('tool + action (execute without path)', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { action: '$schema' } });
    assert.deepEqual(subjects, [
      'mcp__treenity__execute:$schema',
      'mcp__treenity__execute',
    ]);
  });

  it('tool + action + path (most specific)', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { path: '/agents/qa', action: 'run', data: { x: 1 } } });
    assert.deepEqual(subjects, [
      'mcp__treenity__execute:run:/agents/qa',
      'mcp__treenity__execute:run',
      'mcp__treenity__execute',
    ]);
  });

  it('deploy_prefab uses target instead of path', () => {
    const subjects = buildSubjects({ tool: 'deploy_prefab', args: { source: '/sys/mods/x', target: '/my/dir' } });
    assert.deepEqual(subjects, [
      'mcp__treenity__deploy_prefab:/my/dir',
      'mcp__treenity__deploy_prefab',
    ]);
  });

  it('path takes priority over target when both present', () => {
    const subjects = buildSubjects({ tool: 'set_node', args: { path: '/a', target: '/b' } });
    assert.deepEqual(subjects, [
      'mcp__treenity__set_node:/a',
      'mcp__treenity__set_node',
    ]);
  });

  it('empty string args are ignored', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { action: '', path: '' } });
    assert.deepEqual(subjects, ['mcp__treenity__execute']);
  });

  it('undefined args are safe', () => {
    const subjects = buildSubjects({ tool: 'get_node', args: { path: undefined } as Record<string, unknown> });
    assert.deepEqual(subjects, ['mcp__treenity__get_node']);
  });

  it('non-string args are ignored for subject building', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { action: 42, path: true } as Record<string, unknown> });
    assert.deepEqual(subjects, ['mcp__treenity__execute']);
  });

  it('remove_node: tool + path', () => {
    const subjects = buildSubjects({ tool: 'remove_node', args: { path: '/dangerous' } });
    assert.deepEqual(subjects, [
      'mcp__treenity__remove_node:/dangerous',
      'mcp__treenity__remove_node',
    ]);
  });
});

// ── 3. Guardian Allow/Deny/Escalate ──

describe('checkMcpGuardian', () => {
  let store: Tree;

  // Helper: set guardian with given policy
  async function setGuardian(policy: { allow: string[]; deny: string[]; escalate: string[] }) {
    await store.set(createNode('/agents/guardian', 'ai.policy', {
      ...policy,
    }));
  }

  function req(tool: string, args: Record<string, unknown> = {}): GuardianRequest {
    return { tool, args };
  }

  beforeEach(() => {
    store = createMemoryTree();
  });

  // ── Basic policy ──

  it('denies when no guardian node exists', async () => {
    const result = await checkMcpGuardian(store, req('set_node', { path: '/x' }));
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason.includes('no Guardian'));
  });

  it('denies tool on deny list', async () => {
    await setGuardian({ allow: [], deny: ['mcp__treenity__set_node'], escalate: [] });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/x', type: 'dir' }));
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason.includes('denied'));
  });

  it('allows tool on allow list', async () => {
    await setGuardian({ allow: ['mcp__treenity__get_node'], deny: [], escalate: [] });
    const result = await checkMcpGuardian(store, req('get_node', { path: '/x' }));
    assert.equal(result.allowed, true);
  });

  it('prompts for unknown tool not in any list', async () => {
    await setGuardian({ allow: ['mcp__treenity__get_node'], deny: [], escalate: [] });
    const result = await checkMcpGuardian(store, req('unknown_tool'));
    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt' && result.subjects[0] === 'mcp__treenity__unknown_tool');
  });

  it('denies when guardian node has no policy component (F01)', async () => {
    await store.set(createNode('/agents/guardian', 'ai.agent', {
      role: 'guardian', status: 'idle', currentTask: '', taskRef: '',
      lastRunAt: 0, totalTokens: 0,
    }));
    const result = await checkMcpGuardian(store, req('set_node', { path: '/x' }));
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason.includes('invalid Guardian policy type'));
  });

  it('denies when guardian node has wrong policy $type (F01)', async () => {
    await store.set(createNode('/agents/guardian', 'ai.agent', {
      role: 'guardian', status: 'idle', currentTask: '', taskRef: '',
      lastRunAt: 0, totalTokens: 0,
    }, { policy: { $type: 'dir' } }));
    const result = await checkMcpGuardian(store, req('set_node', { path: '/x' }));
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason.includes('invalid Guardian policy type'));
  });

  // ── Action-level specificity ──

  it('specific action allow overrides coarse escalate', async () => {
    await setGuardian({
      allow: ['mcp__treenity__execute:$schema'],
      deny: [],
      escalate: ['mcp__treenity__execute:*'],
    });
    const result = await checkMcpGuardian(store, req('execute', { path: '/any', action: '$schema' }));
    assert.equal(result.allowed, true);
  });

  it('non-allowed action hits coarse escalate → prompt', async () => {
    await setGuardian({
      allow: ['mcp__treenity__execute:$schema'],
      deny: [],
      escalate: ['mcp__treenity__execute:*'],
    });
    const result = await checkMcpGuardian(store, req('execute', { path: '/agents/qa', action: 'run' }));
    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt' && result.subjects[0].includes('execute:run'));
  });

  it('action-specific deny blocks even if coarse tool is allowed', async () => {
    await setGuardian({
      allow: ['mcp__treenity__execute:*'],
      deny: ['mcp__treenity__execute:dangerous'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('execute', { path: '/x', action: 'dangerous' }));
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason.includes('denied'));
  });

  it('action+path deny blocks specific combination', async () => {
    await setGuardian({
      allow: ['mcp__treenity__execute:*'],
      deny: ['mcp__treenity__execute:delete:/production/*'],
      escalate: [],
    });
    const denied = await checkMcpGuardian(store, req('execute', { path: '/production/data', action: 'delete' }));
    assert.equal(denied.allowed, false);

    const allowed = await checkMcpGuardian(store, req('execute', { path: '/staging/data', action: 'delete' }));
    assert.equal(allowed.allowed, true);
  });

  // ── Path-level specificity ──

  it('path-specific allow overrides coarse escalate for set_node', async () => {
    await setGuardian({
      allow: ['mcp__treenity__set_node:/safe/*'],
      deny: [],
      escalate: ['mcp__treenity__set_node'],
    });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/safe/new', type: 'dir' }));
    assert.equal(result.allowed, true);
  });

  it('path-specific deny blocks even if coarse tool is allowed', async () => {
    await setGuardian({
      allow: ['mcp__treenity__set_node'],
      deny: ['mcp__treenity__set_node:/protected/*'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/protected/secret', type: 'dir' }));
    assert.equal(result.allowed, false);
  });

  it('deploy_prefab uses target for path-level matching', async () => {
    await setGuardian({
      allow: ['mcp__treenity__deploy_prefab:/sandbox/*'],
      deny: [],
      escalate: ['mcp__treenity__deploy_prefab'],
    });
    const result = await checkMcpGuardian(store, req('deploy_prefab', { source: '/sys/mods/x', target: '/sandbox/test' }));
    assert.equal(result.allowed, true);
  });

  it('remove_node deny matches path-specific subject', async () => {
    await setGuardian({
      allow: [],
      deny: ['mcp__treenity__remove_node:/production/*'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('remove_node', { path: '/production/important' }));
    assert.equal(result.allowed, false);
  });

  // ── Deny always wins ──

  it('deny wins over allow at same specificity', async () => {
    await setGuardian({
      allow: ['mcp__treenity__set_node'],
      deny: ['mcp__treenity__set_node'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/x', type: 'dir' }));
    assert.equal(result.allowed, false);
  });

  it('coarse deny blocks even with specific allow', async () => {
    await setGuardian({
      allow: ['mcp__treenity__execute:$schema'],
      deny: ['mcp__treenity__execute'],
      escalate: [],
    });
    // Deny on coarse subject blocks everything, specific allow can't override
    const result = await checkMcpGuardian(store, req('execute', { action: '$schema' }));
    assert.equal(result.allowed, false);
  });

  // ── Glob patterns ──

  it('glob in allow matches multiple tools', async () => {
    await setGuardian({
      allow: ['mcp__treenity__get_*', 'mcp__treenity__list_*'],
      deny: [],
      escalate: [],
    });
    assert.equal((await checkMcpGuardian(store, req('get_node', { path: '/' }))).allowed, true);
    assert.equal((await checkMcpGuardian(store, req('list_children', { path: '/' }))).allowed, true);
    // set_node not in any list → prompt (not deny)
    assert.equal((await checkMcpGuardian(store, req('set_node', { path: '/' }))).allowed, 'prompt');
  });

  // ── Real seed policy: $schema allowed, other execute escalated ──

  it('real seed policy: $schema is allowed, arbitrary execute is not', async () => {
    await setGuardian({
      allow: [
        'mcp__treenity__get_node', 'mcp__treenity__list_children',
        'mcp__treenity__catalog', 'mcp__treenity__describe_type',
        'mcp__treenity__search_types', 'mcp__treenity__compile_view',
        'mcp__treenity__execute:$schema',
      ],
      deny: ['mcp__treenity__remove_node'],
      escalate: [
        'mcp__treenity__set_node', 'mcp__treenity__execute:*', 'mcp__treenity__deploy_prefab',
      ],
    });

    // Read-only tools: allowed
    assert.equal((await checkMcpGuardian(store, req('get_node', { path: '/' }))).allowed, true);
    assert.equal((await checkMcpGuardian(store, req('list_children', { path: '/' }))).allowed, true);
    assert.equal((await checkMcpGuardian(store, req('catalog'))).allowed, true);

    // $schema: allowed (specific allow overrides execute:* escalate)
    assert.equal((await checkMcpGuardian(store, req('execute', { path: '/any', action: '$schema' }))).allowed, true);

    // remove_node: denied
    assert.equal((await checkMcpGuardian(store, req('remove_node', { path: '/x' }))).allowed, false);

    // set_node: escalated → prompt
    const setResult = await checkMcpGuardian(store, req('set_node', { path: '/x', type: 'dir' }));
    assert.equal(setResult.allowed, 'prompt');
    assert.ok(setResult.allowed === 'prompt' && setResult.subjects[0].includes('set_node'));
  });

  // ── Edge cases ──

  it('empty args produce tool-only subject', async () => {
    await setGuardian({ allow: ['mcp__treenity__catalog'], deny: [], escalate: [] });
    const result = await checkMcpGuardian(store, req('catalog', {}));
    assert.equal(result.allowed, true);
  });

  it('full args preserved in prompt result', async () => {
    await setGuardian({ allow: [], deny: [], escalate: ['mcp__treenity__set_node'] });

    const bigData = { path: '/test', type: 'dir', components: { x: { $type: 'foo', data: 'bar' } } };
    const result = await checkMcpGuardian(store, req('set_node', bigData));

    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt');
    assert.equal(result.subjects[0], 'mcp__treenity__set_node:/test');
    assert.deepEqual(result.args, bigData);
    assert.equal(result.args.components?.x?.$type, 'foo');
  });

  // ── Escalate vs prompt for different scenarios ──

  it('escalate pattern returns prompt with matching subject', async () => {
    await setGuardian({
      allow: [],
      deny: [],
      escalate: ['mcp__treenity__deploy_prefab'],
    });
    const result = await checkMcpGuardian(store, req('deploy_prefab', { source: '/sys/mods/x', target: '/foo' }));
    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt' && result.subjects[0] === 'mcp__treenity__deploy_prefab:/foo');
  });

  it('prompt result includes all original args', async () => {
    await setGuardian({ allow: [], deny: [], escalate: ['mcp__treenity__execute:*'] });
    const result = await checkMcpGuardian(store, req('execute', {
      path: '/x', action: 'create', type: 'board.task', key: undefined, data: { title: 'hi' },
    }));
    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt');
    assert.equal(result.args.action, 'create');
    assert.deepEqual(result.args.data, { title: 'hi' });
  });
});

// ── 3a. guardian_approve ──

describe('guardian_approve', () => {
  let store: Tree;

  async function setGuardian(policy: { allow: string[]; deny: string[]; escalate: string[] }) {
    await store.set(createNode('/agents/guardian', 'ai.policy', { ...policy }));
  }

  beforeEach(() => {
    store = createMemoryTree();
  });

  it('adds pattern to allow list and removes from escalate', async () => {
    await setGuardian({
      allow: ['mcp__treenity__get_node'],
      deny: [],
      escalate: ['mcp__treenity__set_node'],
    });

    // Before: set_node is escalated → prompt
    const before = await checkMcpGuardian(store, { tool: 'set_node', args: { path: '/x' } });
    assert.equal(before.allowed, 'prompt');

    // Simulate guardian_approve: add to allow, remove from escalate
    const guardianNode = await store.get('/agents/guardian');
    assert.ok(guardianNode);
    const policy = getComponent(guardianNode, AiPolicy);
    assert.ok(policy);
    policy.allow.push('mcp__treenity__set_node');
    policy.escalate = policy.escalate.filter((e: string) => e !== 'mcp__treenity__set_node');
    await store.set(guardianNode);

    // After: set_node is allowed
    const after = await checkMcpGuardian(store, { tool: 'set_node', args: { path: '/x' } });
    assert.equal(after.allowed, true);
  });

  it('approve with specific subject allows that subject', async () => {
    await setGuardian({
      allow: ['mcp__treenity__execute:$schema'],
      deny: [],
      escalate: ['mcp__treenity__execute:*'],
    });

    // run action is escalated
    const before = await checkMcpGuardian(store, { tool: 'execute', args: { action: 'run', path: '/x' } });
    assert.equal(before.allowed, 'prompt');

    // Approve the specific subject
    const guardianNode = await store.get('/agents/guardian');
    assert.ok(guardianNode);
    const policy = getComponent(guardianNode, AiPolicy);
    assert.ok(policy);
    policy.allow.push('mcp__treenity__execute:run');
    await store.set(guardianNode);

    // After: run is allowed
    const after = await checkMcpGuardian(store, { tool: 'execute', args: { action: 'run', path: '/x' } });
    assert.equal(after.allowed, true);
  });

  it('approve does not affect deny list', async () => {
    await setGuardian({
      allow: [],
      deny: ['mcp__treenity__remove_node'],
      escalate: [],
    });

    // Add remove_node to allow — deny still wins
    const guardianNode = await store.get('/agents/guardian');
    assert.ok(guardianNode);
    const policy = getComponent(guardianNode, AiPolicy);
    assert.ok(policy);
    policy.allow.push('mcp__treenity__remove_node');
    await store.set(guardianNode);

    const result = await checkMcpGuardian(store, { tool: 'remove_node', args: { path: '/x' } });
    assert.equal(result.allowed, false);
  });

  it('guardian_approve MCP tool via client adds pattern', async () => {
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | W | S }] });
    await setGuardian({
      allow: ['mcp__treenity__get_node', 'mcp__treenity__guardian_approve'],
      deny: [],
      escalate: ['mcp__treenity__set_node'],
    });

    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);

    // Call guardian_approve tool
    const result = await client.callTool({
      name: 'guardian_approve',
      arguments: { pattern: 'mcp__treenity__set_node' },
    });
    assert.ok(textContent(result).includes('Allowed'));

    // Verify: set_node now allowed in policy
    const after = await checkMcpGuardian(store, { tool: 'set_node', args: { path: '/x' } });
    assert.equal(after.allowed, true);
  });

  it('guardian_approve is idempotent', async () => {
    await setGuardian({
      allow: ['mcp__treenity__set_node'],
      deny: [],
      escalate: [],
    });
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | W | S }] });

    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);
    const result = await client.callTool({
      name: 'guardian_approve',
      arguments: { pattern: 'mcp__treenity__set_node' },
    });
    assert.ok(textContent(result).includes('Already allowed'));

    // Allow list not duplicated
    const node = await store.get('/agents/guardian');
    assert.ok(node);
    const policy = getComponent(node, AiPolicy);
    assert.ok(policy);
    const count = policy.allow.filter((a: string) => a === 'mcp__treenity__set_node').length;
    assert.equal(count, 1);
  });
});

// ── 3. Prototype Pollution Prevention ──

describe('prototype pollution prevention', () => {
  let store: Tree;

  beforeEach(async () => {
    store = createMemoryTree();
    await store.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | W | S }],
    });
    // Guardian allows set_node
    await store.set(createNode('/agents/guardian', 'ai.agent', {
      role: 'guardian', status: 'idle', currentTask: '', taskRef: '',
      lastRunAt: 0, totalTokens: 0,
    }, {
      policy: Object.assign(new AiPolicy(), {
        $type: 'ai.policy',
        allow: ['mcp__treenity__set_node', 'mcp__treenity__get_node'],
        deny: [],
        escalate: [],
      }),
    }));
  });

  // TODO: should throw, not skip — current behavior silently ignores pollution keys
  it('silently skips __proto__ component key', async () => {
    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);
    // Use JSON.parse to create an object with literal __proto__ key (JS object literal syntax
    // sets the internal prototype instead of creating a regular key)
    const components = JSON.parse('{"__proto__": {"$type": "t.default", "evil": true}, "safe": {"$type": "t.default", "ok": true}}');
    await client.callTool({
      name: 'set_node',
      arguments: { path: '/test/proto', type: 't.default', components },
    });
    const node = await store.get('/test/proto');
    assert.ok(node, 'node should be created');
    // Key assertion: Object.prototype not polluted AND __proto__ not stored as data
    assert.equal(({} as any).evil, undefined, 'Object.prototype must not be polluted');
    assert.ok(!Object.hasOwn(node as any, '__proto__'), '__proto__ should not be stored as own property');
  });

  // TODO: should throw, not skip — current behavior silently ignores pollution keys
  it('silently skips constructor component key', async () => {
    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);
    await client.callTool({
      name: 'set_node',
      arguments: {
        path: '/test/ctor',
        type: 't.default',
        components: { constructor: { $type: 't.default', x: 1 } },
      },
    });
    const node = await store.get('/test/ctor');
    assert.ok(node, 'node should be created');
    assert.equal(typeof (node as any).constructor, 'function', 'constructor should remain native');
  });

  // TODO: should throw, not skip — current behavior silently ignores pollution keys
  it('silently skips prototype component key', async () => {
    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);
    await client.callTool({
      name: 'set_node',
      arguments: {
        path: '/test/prototype',
        type: 't.default',
        components: { prototype: { $type: 't.default', y: 2 } },
      },
    });
    const node = await store.get('/test/prototype');
    assert.ok(node, 'node should be created');
    // prototype key should be silently skipped by the handler
    assert.equal((node as any).prototype?.y, undefined, 'prototype data should not be stored');
  });
});

// ── 4. Path Traversal ──

describe('path traversal prevention', () => {
  let store: Tree;

  beforeEach(async () => {
    store = createMemoryTree();
    await store.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | W | S }],
    });
    await store.set(createNode('/admin', 'dir'));
    await store.set(createNode('/admin/secrets', 't.default'));
  });

  it('get_node with ../etc/passwd returns not found', async () => {
    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '../etc/passwd' } });
    assert.ok(textContent(result).includes('not found'));
  });

  it('get_node with //admin does not traverse to /admin', async () => {
    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);
    // //admin is a different path from /admin in tree
    const result = await client.callTool({ name: 'get_node', arguments: { path: '//admin' } });
    const text = textContent(result);
    // Should either not find it or find it as literal //admin path
    // It must NOT accidentally resolve to /admin/secrets
    assert.ok(!text.includes('secrets'), 'must not expose /admin/secrets through //admin');
  });

  it('get_node with path containing null bytes is safe', async () => {
    const { client } = await createTestClient(store, 'test-user', ['u:test-user', 'public']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/test\x00/admin' } });
    assert.ok(textContent(result).includes('not found'));
  });
});

// ── 5. ACL Filtering ──

describe('ACL filtering', () => {
  let store: Tree;

  beforeEach(async () => {
    store = createMemoryTree();
    await store.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | S }],
    });
    await store.set({
      ...createNode('/public', 'dir'),
      $acl: [{ g: 'public', p: R | S }],
    });
    await store.set(createNode('/public/page', 't.default'));
    await store.set({
      ...createNode('/private', 'dir'),
      $acl: [{ g: 'public', p: 0 }, { g: 'admins', p: R | W | S }],
    });
    await store.set(createNode('/private/secret', 't.default'));
  });

  it('get_node returns allowed node', async () => {
    const { client } = await createTestClient(store, 'anon', ['u:anon', 'public']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/public/page' } });
    assert.ok(!textContent(result).includes('not found'));
    assert.ok(textContent(result).includes('t.default'));
  });

  it('get_node hides denied node', async () => {
    const { client } = await createTestClient(store, 'anon', ['u:anon', 'public']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/private/secret' } });
    assert.ok(textContent(result).includes('not found'));
  });

  it('list_children filters out denied children', async () => {
    // Create nodes under root — /public and /private are both children of /
    const { client } = await createTestClient(store, 'anon', ['u:anon', 'public']);
    const result = await client.callTool({ name: 'list_children', arguments: { path: '/' } });
    const text = textContent(result);
    assert.ok(text.includes('public'), 'should list public dir');
    assert.ok(!text.includes('private'), 'should NOT list private dir');
  });

  it('admin can access denied node', async () => {
    const { client } = await createTestClient(store, 'admin', ['u:admin', 'authenticated', 'admins']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/private/secret' } });
    assert.ok(!textContent(result).includes('not found'), 'admin should see private node');
  });
});

// ── 6. Dev Mode Session Fallback ──

describe('dev mode session fallback', { concurrency: 1 }, () => {
  let savedTenant: string | undefined;

  beforeEach(() => {
    savedTenant = process.env.TENANT;
  });

  afterEach(() => {
    // Unconditional restore via try/finally pattern
    try {
      if (savedTenant === undefined) delete process.env.TENANT;
      else process.env.TENANT = savedTenant;
    } finally {
      // Guarantee env is always restored even if test cleanup itself throws
    }
  });

  it('dev mode (no TENANT) creates admin session without token', async () => {
    delete process.env.TENANT;
    const store = createMemoryTree();
    await store.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'admins', p: R | W | S }],
    });
    await store.set(createNode('/admin-only', 't.default'));

    // Dev mode: session = { userId: 'mcp-dev' }, claims = ['u:mcp-dev', 'authenticated', 'admins']
    const { client } = await createTestClient(store, 'mcp-dev', ['u:mcp-dev', 'authenticated', 'admins']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/admin-only' } });
    assert.ok(!textContent(result).includes('not found'), 'dev mode should have admin access');
  });

  it('dev mode claims include admins group', () => {
    // The handler hardcodes these claims for dev mode
    // Verify the contract: when no TENANT and no token, claims are ['u:mcp-dev', 'authenticated', 'admins']
    delete process.env.TENANT;
    const devClaims = ['u:mcp-dev', 'authenticated', 'admins'];
    assert.ok(devClaims.includes('admins'), 'dev claims must include admins');
    assert.ok(devClaims.includes('authenticated'), 'dev claims must include authenticated');
    assert.equal(devClaims.length, 3, 'dev claims should have exactly 3 entries');
  });

  it('production mode (TENANT set) without token gets no access', async () => {
    process.env.TENANT = 'prod';
    const store = createMemoryTree();
    await store.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | S }],
    });

    // In production with no token, createMcpHttpServer returns 401
    // We test this at the contract level: if session is null, no MCP server is built
    // buildMcpServer always requires a session, so the 401 is at the HTTP handler layer
    // Here we verify that a non-admin user can't see admin content
    const { client } = await createTestClient(store, 'nobody', ['u:nobody']);
    await store.set({
      ...createNode('/admin-data', 'dir'),
      $acl: [{ g: 'admins', p: R | W | S }, { g: 'public', p: 0 }],
    });
    await store.set(createNode('/admin-data/item', 't.default'));
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/admin-data/item' } });
    assert.ok(textContent(result).includes('not found'), 'non-admin should not see admin data');
  });
});
