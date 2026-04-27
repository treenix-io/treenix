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

function textContent(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  const t = content.find((c: { type: string; text?: string }) => c.type === 'text');
  return t?.text ?? '';
}

// ── 1. Token Extraction ──

describe('extractToken', () => {
  it('extracts Bearer token from Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123' }, url: '/mcp' } as any;
    assert.equal(extractToken(req), 'abc123');
  });

  it('returns null when no token provided', () => {
    const req = { headers: {}, url: '/mcp' } as any;
    assert.equal(extractToken(req), null);
  });

  // C5: query-string token rejected (was an oracle for access logs/Referer leak)
  it('ignores ?token= query parameter (Bearer header only)', () => {
    const req = { headers: {}, url: '/mcp?token=xyz' } as any;
    assert.equal(extractToken(req), null);
  });

  it('ignores URL-encoded query token', () => {
    const req = { headers: {}, url: '/mcp?token=a%20b%3Dc' } as any;
    assert.equal(extractToken(req), null);
  });

  it('Bearer header still wins regardless of query', () => {
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
    await store.set(createNode('/guardian', 'ai.policy', {
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

  it('denies when guardian node has wrong type (F01)', async () => {
    await store.set(createNode('/guardian', 'ai.agent', {
      role: 'guardian', status: 'idle', currentTask: '', currentRun: '',
      lastRunAt: 0, totalTokens: 0,
    }));
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

// ── 3a. Guardian policy manipulation ──

describe('guardian policy', () => {
  let store: Tree;

  async function setGuardian(policy: { allow: string[]; deny: string[]; escalate: string[] }) {
    await store.set(createNode('/guardian', 'ai.policy', { ...policy }));
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
    const guardianNode = await store.get('/guardian');
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

    // Move from escalate to allow
    const guardianNode = await store.get('/guardian');
    assert.ok(guardianNode);
    const policy = getComponent(guardianNode, AiPolicy);
    assert.ok(policy);
    policy.escalate = [];
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
    const guardianNode = await store.get('/guardian');
    assert.ok(guardianNode);
    const policy = getComponent(guardianNode, AiPolicy);
    assert.ok(policy);
    policy.allow.push('mcp__treenity__remove_node');
    await store.set(guardianNode);

    const result = await checkMcpGuardian(store, { tool: 'remove_node', args: { path: '/x' } });
    assert.equal(result.allowed, false);
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
    await store.set(createNode('/guardian', 'ai.policy', {
      allow: ['mcp__treenity__set_node', 'mcp__treenity__get_node'],
      deny: [],
      escalate: [],
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

// ── 6. buildMcpServer claims contract ──
// (renamed from "dev mode session fallback" — the old name implied this tested
// the HTTP gate, but createTestClient bypasses the handler. Real gate coverage
// lives in `mcp http server integration` below.)

describe('buildMcpServer claims contract', () => {
  it('admin claims grant access to admin-only data', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    await store.set(createNode('/admin-only', 't.default'));
    const { client } = await createTestClient(store, 'mcp-dev', ['u:mcp-dev', 'authenticated', 'admins']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/admin-only' } });
    assert.ok(!textContent(result).includes('not found'));
  });

  it('non-admin claims cannot read admin-only data', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | S }] });
    await store.set({
      ...createNode('/admin-data', 'dir'),
      $acl: [{ g: 'admins', p: R | W | S }, { g: 'public', p: 0 }],
    });
    await store.set(createNode('/admin-data/item', 't.default'));
    const { client } = await createTestClient(store, 'nobody', ['u:nobody']);
    const result = await client.callTool({ name: 'get_node', arguments: { path: '/admin-data/item' } });
    assert.ok(textContent(result).includes('not found'));
  });
});

// ── 7. C5: loopback / dev gate ──

import {
  isLoopbackHost,
  isLoopbackPeer,
  isDevAdminEnabled,
  parseAllowedOrigins,
  setCorsHeaders,
  resolveMcpAuth,
  revalidateSessionAuth,
  type SessionAuth,
} from './mcp-server';

describe('isLoopbackHost', () => {
  it('accepts 127.0.0.1, localhost, ::1', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(isLoopbackHost(h), true, h);
  });
  it('rejects 0.0.0.0, public IP, uppercase LOCALHOST (case-sensitive)', () => {
    for (const h of ['0.0.0.0', '192.168.1.1', '10.0.0.1', 'LOCALHOST', '']) assert.equal(isLoopbackHost(h), false, h);
  });
});

describe('isLoopbackPeer', () => {
  it('accepts 127.x, ::1, ::ffff:127.x', () => {
    for (const a of ['127.0.0.1', '127.255.255.254', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackPeer(a), true, a);
  });
  it('rejects undefined and non-loopback addresses', () => {
    for (const a of [undefined, '', '10.0.0.1', '192.168.1.50', '::', '2001:db8::1']) assert.equal(isLoopbackPeer(a), false, String(a));
  });
});

describe('isDevAdminEnabled', { concurrency: 1 }, () => {
  let savedNodeEnv: string | undefined;
  let savedDevAdmin: string | undefined;
  beforeEach(() => { savedNodeEnv = process.env.NODE_ENV; savedDevAdmin = process.env.MCP_DEV_ADMIN; });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedDevAdmin === undefined) delete process.env.MCP_DEV_ADMIN; else process.env.MCP_DEV_ADMIN = savedDevAdmin;
  });

  it('all 4 conditions present → true', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    assert.equal(isDevAdminEnabled('127.0.0.1', '127.0.0.1'), true);
  });

  it('NODE_ENV != development → false', () => {
    process.env.NODE_ENV = 'production';
    process.env.MCP_DEV_ADMIN = '1';
    assert.equal(isDevAdminEnabled('127.0.0.1', '127.0.0.1'), false);
  });

  it('MCP_DEV_ADMIN unset or wrong value → false', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.MCP_DEV_ADMIN;
    assert.equal(isDevAdminEnabled('127.0.0.1', '127.0.0.1'), false);
    process.env.MCP_DEV_ADMIN = '0';
    assert.equal(isDevAdminEnabled('127.0.0.1', '127.0.0.1'), false);
    process.env.MCP_DEV_ADMIN = 'true';
    assert.equal(isDevAdminEnabled('127.0.0.1', '127.0.0.1'), false);
  });

  it('configured host not loopback → false', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    assert.equal(isDevAdminEnabled('0.0.0.0', '127.0.0.1'), false);
  });

  it('peer not loopback → false (proxy / port-forward bypass blocked)', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    assert.equal(isDevAdminEnabled('127.0.0.1', '192.168.1.50'), false);
    assert.equal(isDevAdminEnabled('127.0.0.1', undefined), false);
  });
});

// ── 8. C5: resolveMcpAuth ──

describe('resolveMcpAuth', { concurrency: 1 }, () => {
  let savedNodeEnv: string | undefined;
  let savedDevAdmin: string | undefined;
  beforeEach(() => { savedNodeEnv = process.env.NODE_ENV; savedDevAdmin = process.env.MCP_DEV_ADMIN; });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedDevAdmin === undefined) delete process.env.MCP_DEV_ADMIN; else process.env.MCP_DEV_ADMIN = savedDevAdmin;
  });

  it('valid token → ok with auth.kind=token', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    const token = await createSession(store, 'alice');
    const r = await resolveMcpAuth(store, token, '127.0.0.1', '127.0.0.1');
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.auth.kind, 'token');
      assert.equal(r.session.userId, 'alice');
    }
  });

  it('invalid token → 401 invalid_token', async () => {
    const store = createMemoryTree();
    const r = await resolveMcpAuth(store, 'a'.repeat(64), '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'invalid_token');
    }
  });

  it('no token + production → 401 token_required', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MCP_DEV_ADMIN;
    const store = createMemoryTree();
    const r = await resolveMcpAuth(store, null, '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'token_required');
  });

  it('no token + dev gate complete → ok with auth.kind=dev', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    const store = createMemoryTree();
    const r = await resolveMcpAuth(store, null, '127.0.0.1', '127.0.0.1');
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.auth.kind, 'dev');
      assert.deepEqual(r.devClaims, ['u:mcp-dev', 'authenticated', 'admins']);
      if (r.auth.kind === 'dev') assert.ok(r.auth.expiresAt > Date.now());
    }
  });

  it('no token + NODE_ENV=development without MCP_DEV_ADMIN → 401', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.MCP_DEV_ADMIN;
    const store = createMemoryTree();
    const r = await resolveMcpAuth(store, null, '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'token_required');
  });

  it('no token + dev opts on but peer not loopback → 401', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    const store = createMemoryTree();
    const r = await resolveMcpAuth(store, null, '127.0.0.1', '192.168.1.50');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'token_required');
  });

  it('no token + dev opts on but configured host not loopback → 401', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    const store = createMemoryTree();
    const r = await resolveMcpAuth(store, null, '0.0.0.0', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'token_required');
  });
});

// ── 9. C5: revalidateSessionAuth ──

describe('revalidateSessionAuth', { concurrency: 1 }, () => {
  let savedNodeEnv: string | undefined;
  let savedDevAdmin: string | undefined;
  beforeEach(() => { savedNodeEnv = process.env.NODE_ENV; savedDevAdmin = process.env.MCP_DEV_ADMIN; });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedDevAdmin === undefined) delete process.env.MCP_DEV_ADMIN; else process.env.MCP_DEV_ADMIN = savedDevAdmin;
  });

  it('token-bound: matching token + still resolvable → ok', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    const token = await createSession(store, 'alice');
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token };
    const r = await revalidateSessionAuth(store, cached, token, '127.0.0.1', '127.0.0.1');
    assert.ok(r.ok);
  });

  it('token-bound: token mismatch → 401 token_mismatch', async () => {
    const store = createMemoryTree();
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token: 'a'.repeat(64) };
    const r = await revalidateSessionAuth(store, cached, 'b'.repeat(64), '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'token_mismatch');
  });

  it('token-bound: token revoked since session creation → 401 token_invalid', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    const token = await createSession(store, 'alice');
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token };
    // revoke
    await store.remove(`/auth/sessions/${token}`);
    const r = await revalidateSessionAuth(store, cached, token, '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'token_invalid');
  });

  it('dev-bound: TTL ok + dev gate ok → ok', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    const store = createMemoryTree();
    const cached: SessionAuth = { kind: 'dev', expiresAt: Date.now() + 60_000 };
    const r = await revalidateSessionAuth(store, cached, null, '127.0.0.1', '127.0.0.1');
    assert.ok(r.ok);
  });

  it('dev-bound: TTL expired → 401 dev_session_expired', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    const store = createMemoryTree();
    const cached: SessionAuth = { kind: 'dev', expiresAt: Date.now() - 1_000 };
    const r = await revalidateSessionAuth(store, cached, null, '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'dev_session_expired');
  });

  it('dev-bound: dev gate dropped (env-flip) → 401 dev_mode_disabled', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MCP_DEV_ADMIN = '1';
    const store = createMemoryTree();
    const cached: SessionAuth = { kind: 'dev', expiresAt: Date.now() + 60_000 };
    const r = await revalidateSessionAuth(store, cached, null, '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'dev_mode_disabled');
  });
});

// ── 10. C5: CORS ──

describe('parseAllowedOrigins', () => {
  it('empty/undefined → []', () => {
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins(''), []);
  });
  it('comma + whitespace → trimmed list', () => {
    assert.deepEqual(parseAllowedOrigins('https://a.com, https://b.com,https://c.com '),
      ['https://a.com', 'https://b.com', 'https://c.com']);
  });
  it('wildcard * is rejected (warn)', () => {
    assert.deepEqual(parseAllowedOrigins('*'), []);
    assert.deepEqual(parseAllowedOrigins('*,https://a.com'), ['https://a.com']);
  });
});

describe('setCorsHeaders', { concurrency: 1 }, () => {
  let savedOrigins: string | undefined;
  beforeEach(() => { savedOrigins = process.env.MCP_CORS_ORIGINS; });
  afterEach(() => {
    if (savedOrigins === undefined) delete process.env.MCP_CORS_ORIGINS;
    else process.env.MCP_CORS_ORIGINS = savedOrigins;
  });

  function mkRes() {
    const headers: Record<string, string> = {};
    return { headers, setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
  }

  it('origin in allowlist → Allow-Origin echoes + Vary: Origin', () => {
    process.env.MCP_CORS_ORIGINS = 'https://app.example.com';
    const req = { headers: { origin: 'https://app.example.com' } } as any;
    const res = mkRes();
    setCorsHeaders(req, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://app.example.com');
    assert.equal(res.headers.Vary, 'Origin');
  });

  it('origin not in allowlist → no Allow-Origin, but Vary still set', () => {
    process.env.MCP_CORS_ORIGINS = 'https://app.example.com';
    const req = { headers: { origin: 'https://evil.com' } } as any;
    const res = mkRes();
    setCorsHeaders(req, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
    assert.equal(res.headers.Vary, 'Origin');
  });

  it('no Origin header → neither Allow-Origin nor Vary', () => {
    process.env.MCP_CORS_ORIGINS = 'https://a.com';
    const req = { headers: {} } as any;
    const res = mkRes();
    setCorsHeaders(req, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
    assert.equal(res.headers.Vary, undefined);
  });

  it('Method/Header allowlists set unconditionally', () => {
    const req = { headers: {} } as any;
    const res = mkRes();
    setCorsHeaders(req, res);
    assert.ok(res.headers['Access-Control-Allow-Methods'].includes('OPTIONS'));
    assert.ok(res.headers['Access-Control-Allow-Headers'].includes('Authorization'));
  });
});

// ── 11. C5: HTTP integration ──

import { createMcpHttpServer } from './mcp-server';
import { AddressInfo } from 'node:net';

describe('mcp http server integration', { concurrency: 1 }, () => {
  let savedNodeEnv: string | undefined;
  let savedDevAdmin: string | undefined;
  beforeEach(() => { savedNodeEnv = process.env.NODE_ENV; savedDevAdmin = process.env.MCP_DEV_ADMIN; });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedDevAdmin === undefined) delete process.env.MCP_DEV_ADMIN; else process.env.MCP_DEV_ADMIN = savedDevAdmin;
  });

  async function listen(store: Tree): Promise<{ port: number; close: () => void }> {
    const server = createMcpHttpServer(store, 0);   // ephemeral port
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    return { port, close: () => server.close() };
  }

  function initBody(): string {
    return JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
  }

  it('I1: no token + production → 401 with WWW-Authenticate: Bearer', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MCP_DEV_ADMIN;
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }] });
    const srv = await listen(store);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: initBody(),
      });
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/);
      const body = await res.json();
      assert.equal(body.error, 'token_required');
    } finally { srv.close(); }
  });

  it('I2: valid Bearer token → 200, mcp-session-id echoed', async () => {
    process.env.NODE_ENV = 'production';
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    const token = await createSession(store, 'alice', { claims: ['u:alice', 'admins'] });
    const srv = await listen(store);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${token}`,
        },
        body: initBody(),
      });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('mcp-session-id'), 'session-id header present');
    } finally { srv.close(); }
  });

  it('I4: reconnect with different token → 401 token_mismatch, session evicted', async () => {
    process.env.NODE_ENV = 'production';
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    const token1 = await createSession(store, 'alice', { claims: ['u:alice', 'admins'] });
    const token2 = await createSession(store, 'bob', { claims: ['u:bob', 'admins'] });
    const srv = await listen(store);
    try {
      const init = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${token1}`,
        },
        body: initBody(),
      });
      const sid = init.headers.get('mcp-session-id')!;
      assert.ok(sid);

      // Reconnect with bob's token (different) — must fail
      const reuse = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${token2}`,
          'mcp-session-id': sid,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      assert.equal(reuse.status, 401);
      const body = await reuse.json();
      assert.equal(body.error, 'token_mismatch');

      // Same sid now evicted: should now answer 404 session_not_found
      const after = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${token1}`,
          'mcp-session-id': sid,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      assert.equal(after.status, 404);
    } finally { srv.close(); }
  });
});
