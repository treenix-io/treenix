// MCP Server test suite — token extraction, guardian, ACL, dev mode, security
//
// Tests buildMcpServer via MCP SDK in-process transport (Client ↔ Server).
// No HTTP layer — that belongs in e2e tests.

import '#agent/types';
import '#agent/guardian';

import { AiPolicy } from '#agent/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNode, getComponent, R, resolve, S, W } from '@treenx/core';
import { loadTestSchemas } from '@treenx/core/schema/load';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { buildClaims, createSession, sessionPath, withAcl } from '@treenx/core/server/auth';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import './server';

import {
  buildMcpServer,
  buildSubjects,
  checkMcpGuardian,
  extractToken,
  formatCatalog,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  yaml,
  type GuardianRequest,
} from './mcp-server';

loadTestSchemas(import.meta.url);

// ── Helpers ──

async function ensureMcpTarget(store: Tree, userId?: string) {
  const existing = await store.get('/sys/mcp/tools');
  if (!existing) {
    await store.set({
      ...createNode('/sys/mcp/tools', 'mcp.treenix'),
      $acl: [
        { g: 'public', p: R },
        { g: 'authenticated', p: R },
        { g: 'admins', p: R },
        ...(userId ? [{ g: `u:${userId}`, p: R }] : []),
      ],
    });
    return;
  }
  if (userId) {
    existing.$acl = [
      ...(existing.$acl ?? []),
      { g: `u:${userId}`, p: R },
    ];
    await store.set(existing);
  }
}

/** Create in-process MCP client connected to buildMcpServer */
async function createTestClient(store: Tree, userId: string, claims?: string[]) {
  await ensureMcpTarget(store, userId);
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

describe('MCP auth discovery metadata', () => {
  it('uses the route-specific OAuth protected resource metadata path', () => {
    assert.equal(
      protectedResourceMetadataPath('/mcp'),
      '/.well-known/oauth-protected-resource/mcp',
    );
    assert.equal(
      protectedResourceMetadataPath('/agent/mcp'),
      '/.well-known/oauth-protected-resource/agent/mcp',
    );
  });

  it('builds protected resource metadata with configured authorization server', () => {
    const req = { headers: { host: 'example.com' } } as any;
    assert.deepEqual(protectedResourceMetadata(req, {
      routePath: '/mcp',
      authorizationServer: 'https://auth.example.com',
    }), {
      resource: 'http://example.com/mcp',
      resource_name: 'Treenix MCP',
      bearer_methods_supported: ['header'],
      scopes_supported: ['treenix'],
      authorization_servers: ['https://auth.example.com'],
    });
  });

  it('defaults authorization server to the resource origin', () => {
    const req = { headers: { host: 'example.com' } } as any;
    const metadata = protectedResourceMetadata(req, { routePath: '/mcp' });
    assert.deepEqual(metadata.authorization_servers, ['http://example.com']);
  });
});

// ── 2. buildSubjects — subject construction from GuardianRequest ──

describe('MCP text formatting', () => {
  it('preserves nested YAML indentation', () => {
    assert.equal(
      yaml([{
        name: 'whisper.audio',
        propertyDocs: { mime: { type: 'string', required: true } },
        required: ['filename', 'size', 'mime'],
      }]),
      [
        '- name: whisper.audio',
        '  propertyDocs:',
        '    mime:',
        '      type: string',
        '      required: true',
        '  required: [filename, size, mime]',
      ].join('\n'),
    );
  });

  it('formats catalog entries for LLM discovery without type-only field noise', () => {
    const out = formatCatalog([
      {
        name: 'whisper.config',
        title: 'Speech-to-text config — Whisper model, language, audio path',
        properties: ['model', 'language', 'audioDir', 'url'],
        actions: [],
      },
      {
        name: 'whisper.inbox',
        title: 'Bridge: auto-send whisper transcriptions to a task inbox',
        properties: ['source', 'target'],
        actions: [],
        propertyDocs: {
          source: {
            type: 'string',
            format: 'path',
            description: 'Whisper channel to watch, e.g. /whisper/kriz',
            required: true,
          },
        },
      },
    ]);

    assert.ok(out.includes('fields: model, language, audioDir, url'));
    assert.ok(out.includes('field notes:\n    - source: path — Whisper channel to watch'));
    assert.ok(!out.includes('type: string'));
    assert.ok(!out.includes('required: true'));
  });
});

describe('mcp generic target schema', () => {
  it('loads tool descriptions from the shared mcp.treenix schema', () => {
    const schema = (resolve('mcp.treenix', 'schema') as () => any)();
    assert.equal(schema.methods.get_node.description, 'Read a node by path. Returns full untruncated values.');
    assert.equal(schema.methods.get_node.arguments[0].properties.path.description, 'Node path to read.');
    assert.equal(schema.methods.list_children.arguments[0].properties.detail.description, 'Include first-level fields and component types.');
  });

  it('exposes target node methods as MCP tools', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | S }] });
    const { client } = await createTestClient(store, 'anon', ['u:anon', 'public']);
    const listed = await client.listTools();
    const names = listed.tools.map(t => t.name);
    assert.ok(names.includes('get_node'));
    assert.ok(names.includes('list_children'));
    assert.ok(names.includes('catalog'));
  });
});

describe('mcp guardian elicitation', () => {
  it('does not guard delegated read-only execute calls by the wrapper action', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | W | S }] });
    await store.set(createNode('/guardian', 'ai.policy', {
      allow: [],
      deny: [],
      escalate: ['mcp__treenix__execute'],
    }));

    const { client } = await createTestClient(store, 'anon', ['u:anon', 'public']);
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        path: '/sys/mcp/tools',
        action: 'describe_type',
        data: { type: 'mcp.server' },
      },
    });
    assert.match(textContent(result), /name: mcp.server/);
  });

  it('does not fall back to blocking tree approval when client lacks form elicitation', async () => {
    const saved = process.env.MCP_GUARDIAN_TREE_APPROVAL;
    delete process.env.MCP_GUARDIAN_TREE_APPROVAL;
    try {
      const store = createMemoryTree();
      await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | W | S }] });
      await store.set(createNode('/guardian', 'ai.policy', {
        allow: [],
        deny: [],
        escalate: ['mcp__treenix__set_node'],
      }));

      const { client } = await createTestClient(store, 'anon', ['u:anon', 'public']);
      const result = await client.callTool({
        name: 'set_node',
        arguments: { path: '/x', type: 'dir' },
      });
      assert.match(textContent(result), /did not advertise form elicitation support/);
    } finally {
      if (saved === undefined) delete process.env.MCP_GUARDIAN_TREE_APPROVAL;
      else process.env.MCP_GUARDIAN_TREE_APPROVAL = saved;
    }
  });
});

describe('buildSubjects', () => {
  it('tool-only: no action, no path', () => {
    const subjects = buildSubjects({ tool: 'catalog', args: {} });
    assert.deepEqual(subjects, ['mcp__treenix__catalog']);
  });

  it('tool + path', () => {
    const subjects = buildSubjects({ tool: 'set_node', args: { path: '/foo/bar', type: 'dir' } });
    assert.deepEqual(subjects, [
      'mcp__treenix__set_node:/foo/bar',
      'mcp__treenix__set_node',
    ]);
  });

  it('tool + action (execute without path)', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { action: '$schema' } });
    assert.deepEqual(subjects, [
      'mcp__treenix__execute:$schema',
      'mcp__treenix__execute',
    ]);
  });

  it('tool + action + path (most specific)', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { path: '/agents/qa', action: 'run', data: { x: 1 } } });
    assert.deepEqual(subjects, [
      'mcp__treenix__execute:run:/agents/qa',
      'mcp__treenix__execute:run',
      'mcp__treenix__execute',
    ]);
  });

  it('deploy_prefab uses target instead of path', () => {
    const subjects = buildSubjects({ tool: 'deploy_prefab', args: { source: '/sys/mods/x', target: '/my/dir' } });
    assert.deepEqual(subjects, [
      'mcp__treenix__deploy_prefab:/my/dir',
      'mcp__treenix__deploy_prefab',
    ]);
  });

  it('path takes priority over target when both present', () => {
    const subjects = buildSubjects({ tool: 'set_node', args: { path: '/a', target: '/b' } });
    assert.deepEqual(subjects, [
      'mcp__treenix__set_node:/a',
      'mcp__treenix__set_node',
    ]);
  });

  it('empty string args are ignored', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { action: '', path: '' } });
    assert.deepEqual(subjects, ['mcp__treenix__execute']);
  });

  it('undefined args are safe', () => {
    const subjects = buildSubjects({ tool: 'get_node', args: { path: undefined } as Record<string, unknown> });
    assert.deepEqual(subjects, ['mcp__treenix__get_node']);
  });

  it('non-string args are ignored for subject building', () => {
    const subjects = buildSubjects({ tool: 'execute', args: { action: 42, path: true } as Record<string, unknown> });
    assert.deepEqual(subjects, ['mcp__treenix__execute']);
  });

  it('remove_node: tool + path', () => {
    const subjects = buildSubjects({ tool: 'remove_node', args: { path: '/dangerous' } });
    assert.deepEqual(subjects, [
      'mcp__treenix__remove_node:/dangerous',
      'mcp__treenix__remove_node',
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
    await setGuardian({ allow: [], deny: ['mcp__treenix__set_node'], escalate: [] });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/x', type: 'dir' }));
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason.includes('denied'));
  });

  it('allows tool on allow list', async () => {
    await setGuardian({ allow: ['mcp__treenix__get_node'], deny: [], escalate: [] });
    const result = await checkMcpGuardian(store, req('get_node', { path: '/x' }));
    assert.equal(result.allowed, true);
  });

  it('prompts for unknown tool not in any list', async () => {
    await setGuardian({ allow: ['mcp__treenix__get_node'], deny: [], escalate: [] });
    const result = await checkMcpGuardian(store, req('unknown_tool'));
    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt' && result.subjects[0] === 'mcp__treenix__unknown_tool');
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
      allow: ['mcp__treenix__execute:$schema'],
      deny: [],
      escalate: ['mcp__treenix__execute:*'],
    });
    const result = await checkMcpGuardian(store, req('execute', { path: '/any', action: '$schema' }));
    assert.equal(result.allowed, true);
  });

  it('non-allowed action hits coarse escalate → prompt', async () => {
    await setGuardian({
      allow: ['mcp__treenix__execute:$schema'],
      deny: [],
      escalate: ['mcp__treenix__execute:*'],
    });
    const result = await checkMcpGuardian(store, req('execute', { path: '/agents/qa', action: 'run' }));
    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt' && result.subjects[0].includes('execute:run'));
  });

  it('action-specific deny blocks even if coarse tool is allowed', async () => {
    await setGuardian({
      allow: ['mcp__treenix__execute:*'],
      deny: ['mcp__treenix__execute:dangerous'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('execute', { path: '/x', action: 'dangerous' }));
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason.includes('denied'));
  });

  it('action+path deny blocks specific combination', async () => {
    await setGuardian({
      allow: ['mcp__treenix__execute:*'],
      deny: ['mcp__treenix__execute:delete:/production/*'],
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
      allow: ['mcp__treenix__set_node:/safe/*'],
      deny: [],
      escalate: ['mcp__treenix__set_node'],
    });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/safe/new', type: 'dir' }));
    assert.equal(result.allowed, true);
  });

  it('path-specific deny blocks even if coarse tool is allowed', async () => {
    await setGuardian({
      allow: ['mcp__treenix__set_node'],
      deny: ['mcp__treenix__set_node:/protected/*'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/protected/secret', type: 'dir' }));
    assert.equal(result.allowed, false);
  });

  it('deploy_prefab uses target for path-level matching', async () => {
    await setGuardian({
      allow: ['mcp__treenix__deploy_prefab:/sandbox/*'],
      deny: [],
      escalate: ['mcp__treenix__deploy_prefab'],
    });
    const result = await checkMcpGuardian(store, req('deploy_prefab', { source: '/sys/mods/x', target: '/sandbox/test' }));
    assert.equal(result.allowed, true);
  });

  it('remove_node deny matches path-specific subject', async () => {
    await setGuardian({
      allow: [],
      deny: ['mcp__treenix__remove_node:/production/*'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('remove_node', { path: '/production/important' }));
    assert.equal(result.allowed, false);
  });

  // ── Deny always wins ──

  it('deny wins over allow at same specificity', async () => {
    await setGuardian({
      allow: ['mcp__treenix__set_node'],
      deny: ['mcp__treenix__set_node'],
      escalate: [],
    });
    const result = await checkMcpGuardian(store, req('set_node', { path: '/x', type: 'dir' }));
    assert.equal(result.allowed, false);
  });

  it('coarse deny blocks even with specific allow', async () => {
    await setGuardian({
      allow: ['mcp__treenix__execute:$schema'],
      deny: ['mcp__treenix__execute'],
      escalate: [],
    });
    // Deny on coarse subject blocks everything, specific allow can't override
    const result = await checkMcpGuardian(store, req('execute', { action: '$schema' }));
    assert.equal(result.allowed, false);
  });

  // ── Glob patterns ──

  it('glob in allow matches multiple tools', async () => {
    await setGuardian({
      allow: ['mcp__treenix__get_*', 'mcp__treenix__list_*'],
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
        'mcp__treenix__get_node', 'mcp__treenix__list_children',
        'mcp__treenix__catalog', 'mcp__treenix__describe_type',
        'mcp__treenix__search_types', 'mcp__treenix__compile_view',
        'mcp__treenix__execute:$schema',
      ],
      deny: ['mcp__treenix__remove_node'],
      escalate: [
        'mcp__treenix__set_node', 'mcp__treenix__execute:*', 'mcp__treenix__deploy_prefab',
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
    await setGuardian({ allow: ['mcp__treenix__catalog'], deny: [], escalate: [] });
    const result = await checkMcpGuardian(store, req('catalog', {}));
    assert.equal(result.allowed, true);
  });

  it('full args preserved in prompt result', async () => {
    await setGuardian({ allow: [], deny: [], escalate: ['mcp__treenix__set_node'] });

    const bigData = { path: '/test', type: 'dir', components: { x: { $type: 'foo', data: 'bar' } } };
    const result = await checkMcpGuardian(store, req('set_node', bigData));

    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt');
    assert.equal(result.subjects[0], 'mcp__treenix__set_node:/test');
    assert.deepEqual(result.args, bigData);
    assert.equal(result.args.components?.x?.$type, 'foo');
  });

  // ── Escalate vs prompt for different scenarios ──

  it('escalate pattern returns prompt with matching subject', async () => {
    await setGuardian({
      allow: [],
      deny: [],
      escalate: ['mcp__treenix__deploy_prefab'],
    });
    const result = await checkMcpGuardian(store, req('deploy_prefab', { source: '/sys/mods/x', target: '/foo' }));
    assert.equal(result.allowed, 'prompt');
    assert.ok(result.allowed === 'prompt' && result.subjects[0] === 'mcp__treenix__deploy_prefab:/foo');
  });

  it('prompt result includes all original args', async () => {
    await setGuardian({ allow: [], deny: [], escalate: ['mcp__treenix__execute:*'] });
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
      allow: ['mcp__treenix__get_node'],
      deny: [],
      escalate: ['mcp__treenix__set_node'],
    });

    // Before: set_node is escalated → prompt
    const before = await checkMcpGuardian(store, { tool: 'set_node', args: { path: '/x' } });
    assert.equal(before.allowed, 'prompt');

    // Simulate guardian_approve: add to allow, remove from escalate
    const guardianNode = await store.get('/guardian');
    assert.ok(guardianNode);
    const policy = getComponent(guardianNode, AiPolicy);
    assert.ok(policy);
    policy.allow.push('mcp__treenix__set_node');
    policy.escalate = policy.escalate.filter((e: string) => e !== 'mcp__treenix__set_node');
    await store.set(guardianNode);

    // After: set_node is allowed
    const after = await checkMcpGuardian(store, { tool: 'set_node', args: { path: '/x' } });
    assert.equal(after.allowed, true);
  });

  it('approve with specific subject allows that subject', async () => {
    await setGuardian({
      allow: ['mcp__treenix__execute:$schema'],
      deny: [],
      escalate: ['mcp__treenix__execute:*'],
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
    policy.allow.push('mcp__treenix__execute:run');
    await store.set(guardianNode);

    // After: run is allowed
    const after = await checkMcpGuardian(store, { tool: 'execute', args: { action: 'run', path: '/x' } });
    assert.equal(after.allowed, true);
  });

  it('approve does not affect deny list', async () => {
    await setGuardian({
      allow: [],
      deny: ['mcp__treenix__remove_node'],
      escalate: [],
    });

    // Add remove_node to allow — deny still wins
    const guardianNode = await store.get('/guardian');
    assert.ok(guardianNode);
    const policy = getComponent(guardianNode, AiPolicy);
    assert.ok(policy);
    policy.allow.push('mcp__treenix__remove_node');
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
      allow: ['mcp__treenix__set_node', 'mcp__treenix__get_node'],
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
      assert.deepEqual(r.claims, ['u:mcp-dev', 'authenticated', 'admins']);
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
    // Match what buildClaims would yield for alice (session has no explicit claims):
    //   ['u:alice', 'authenticated']  (no extra groups since /auth/users/alice doesn't exist)
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token, claims: ['u:alice', 'authenticated'] };
    const r = await revalidateSessionAuth(store, cached, token, '127.0.0.1', '127.0.0.1');
    assert.ok(r.ok);
  });

  it('token-bound: token mismatch → 401 token_mismatch', async () => {
    const store = createMemoryTree();
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token: 'a'.repeat(64), claims: [] };
    const r = await revalidateSessionAuth(store, cached, 'b'.repeat(64), '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'token_mismatch');
  });

  it('token-bound: token revoked since session creation → 401 token_invalid', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    const token = await createSession(store, 'alice');
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token, claims: ['u:alice', 'authenticated'] };
    // revoke
    await store.remove(sessionPath(token));
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
    await ensureMcpTarget(store);
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
      const challenge = res.headers.get('www-authenticate') ?? '';
      assert.match(challenge, /^Bearer/);
      assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
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

  it('I0 (round 4): token with explicit `admins` claim BUT user not in admins group must NOT bootstrap admin MCP', async () => {
    // Codex round 4: previously buildMcpServer used session.claims when set,
    // bypassing the always-buildClaims policy on initial auth. After fix the
    // handler passes the computed (buildClaims-derived) claims, so an
    // explicit-claims token can no longer escalate beyond the user's actual
    // group membership.
    process.env.NODE_ENV = 'production';
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | S }] });
    await store.set({
      ...createNode('/admin-data', 'dir'),
      $acl: [{ g: 'admins', p: R | W | S }, { g: 'public', p: 0 }],
    });
    await store.set(createNode('/admin-data/secret', 't.default'));
    // User exists but is NOT in admins group
    await store.set({
      ...createNode('/auth/users/alice', 'user'),
      $owner: 'alice',
      groups: { $type: 'groups', list: [] },
    });
    // Token issued with explicit elevated claims (forged or stale grant)
    const token = await createSession(store, 'alice', { claims: ['u:alice', 'authenticated', 'admins'] });
    const srv = await listen(store);
    try {
      const init = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${token}`,
        },
        body: initBody(),
      });
      // 200 ok — auth itself succeeds, but with downgraded (buildClaims) effective claims
      assert.equal(init.status, 200);
      const sid = init.headers.get('mcp-session-id')!;

      // Now call get_node on /admin-data/secret. Without the round-4 fix, the
      // explicit `admins` claim grants access. With fix, buildClaims = ['u:alice',
      // 'authenticated'] → no `admins` → access denied (returned as "not found"
      // from MCP because withAcl strips the node).
      const callRes = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${token}`,
          'mcp-session-id': sid,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'get_node', arguments: { path: '/admin-data/secret' } },
        }),
      });
      const body = await callRes.text();
      // Result is text/event-stream or json; either way, must say not found, not the node
      assert.ok(body.includes('not found') || body.includes('"isError":true'),
        `expected access denial, got: ${body.slice(0, 200)}`);
    } finally { srv.close(); }
  });

  it('I4: reconnect with different token → 401 token_mismatch BUT legit session preserved (DoS guard)', async () => {
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

      // C5 round 2 (DoS guard): mismatch must NOT evict — sid disclosure should
      // not allow an unauthenticated client to kill the legit session.
      // Owner's reconnect with original token must still succeed.
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
      assert.notEqual(after.status, 404, 'session must survive token mismatch');
    } finally { srv.close(); }
  });
});

// ── 12. C5 round 2: bounded TTL parsing ──

import { parseDevTtlMs, hasProxyHeaders } from './mcp-server';

describe('parseDevTtlMs (C5 round 2 — bounded TTL)', () => {
  const DEFAULT = 60 * 60 * 1000;
  it('undefined → default 1h', () => {
    assert.equal(parseDevTtlMs(undefined), DEFAULT);
  });
  it('valid integer in range → parsed', () => {
    assert.equal(parseDevTtlMs('120000'), 120_000);
  });
  it('NaN-source rejected → default', () => {
    assert.equal(parseDevTtlMs('abc'), DEFAULT);
  });
  it('Infinity rejected → default', () => {
    assert.equal(parseDevTtlMs('Infinity'), DEFAULT);
  });
  it('below floor (1m) rejected → default', () => {
    assert.equal(parseDevTtlMs('1000'), DEFAULT);   // 1s, too short
  });
  it('above ceiling (1h) rejected → default (round 3: tighter cap)', () => {
    assert.equal(parseDevTtlMs(String(60 * 60 * 1000 + 1)), DEFAULT);
    assert.equal(parseDevTtlMs('999999999'), DEFAULT);
  });
  it('exactly at ceiling (1h) accepted', () => {
    assert.equal(parseDevTtlMs('3600000'), 3600000);
  });
  it('negative rejected → default', () => {
    assert.equal(parseDevTtlMs('-60000'), DEFAULT);
  });
});

// ── 13. C5 round 2: proxy-header rejection in dev fallback ──

describe('hasProxyHeaders (C5 round 2 + 3)', () => {
  it('detects each proxy header (incl. round-3 expansions)', () => {
    for (const h of [
      'forwarded', 'x-forwarded-for', 'x-real-ip', 'via',
      'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
      'x-client-ip', 'cf-connecting-ip', 'true-client-ip', 'cdn-loop',
    ]) {
      const req = { headers: { [h]: 'something' } } as any;
      assert.equal(hasProxyHeaders(req), true, h);
    }
  });
  it('returns false when none present', () => {
    assert.equal(hasProxyHeaders({ headers: {} } as any), false);
  });
  // round 3: presence not truthiness — empty string still counts
  it('treats empty-string header value as present (presence-check)', () => {
    assert.equal(hasProxyHeaders({ headers: { 'x-forwarded-for': '' } } as any), true);
  });
});

describe('isDevAdminEnabled with proxy header (C5 round 2)', { concurrency: 1 }, () => {
  let savedNodeEnv: string | undefined;
  let savedDevAdmin: string | undefined;
  beforeEach(() => { savedNodeEnv = process.env.NODE_ENV; savedDevAdmin = process.env.MCP_DEV_ADMIN; });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedDevAdmin === undefined) delete process.env.MCP_DEV_ADMIN; else process.env.MCP_DEV_ADMIN = savedDevAdmin;
  });

  it('proxy-header present → false even with all other gates open', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    assert.equal(isDevAdminEnabled('127.0.0.1', '127.0.0.1', true), false);
  });
  it('proxy-header absent → unaffected (true if other gates open)', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_DEV_ADMIN = '1';
    assert.equal(isDevAdminEnabled('127.0.0.1', '127.0.0.1', false), true);
  });
});

// ── 14. C5 round 2: claims drift on token reconnect ──

describe('revalidateSessionAuth claims drift (C5 round 2 + 3)', { concurrency: 1 }, () => {
  // Round 3: same-token group demotion via buildClaims (the realistic attack).
  // User's groups changed mid-session; old MCP session must die on reconnect.
  it('token-bound: same-token user-groups demotion → claims_changed', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    await store.set({
      ...createNode('/auth/users/alice', 'user'),
      $owner: 'alice',
      groups: { $type: 'groups', list: ['editors'] },
    });
    // Session created WITHOUT explicit claims → claims resolved dynamically via buildClaims
    const token = await createSession(store, 'alice');
    const initialClaims = await buildClaims(store, 'alice');
    assert.ok(initialClaims.includes('editors'));
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token, claims: initialClaims };

    // Demote alice — drop 'editors' group
    const userNode = (await store.get('/auth/users/alice'))!;
    (userNode.groups as any).list = [];
    await store.set(userNode);

    // Reconnect with same token: revalidate must detect group demotion
    const r = await revalidateSessionAuth(store, cached, token, '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'claims_changed');
  });

  it('token-bound: claims set changed since init → 401 claims_changed (forces reinit)', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | S }] });
    // Create user with `editor` group claim, then session
    await store.set({
      ...createNode('/auth/users/alice', 'user'),
      $owner: 'alice',
      groups: { $type: 'groups', list: ['editors'] },
    });
    const initialClaims = ['u:alice', 'authenticated', 'editors'];
    const token = await createSession(store, 'alice', { claims: initialClaims });
    const cached: SessionAuth = { kind: 'token', userId: 'alice', token, claims: initialClaims };

    // Drift the user's groups: drop editors
    const userNode = (await store.get('/auth/users/alice'))!;
    (userNode.groups as any).list = [];
    await store.set(userNode);

    // Recreate session with new claims via createSession to mirror handler-side update
    const driftedClaims = ['u:alice', 'authenticated'];
    await store.remove(sessionPath(token));
    // Re-issue new token with new claims (we pretend the auth layer re-issues)
    const token2 = await createSession(store, 'alice', { claims: driftedClaims });
    // Cached pre-drift: token would be old token, but here we'll test: matching
    // token but downgraded user → revalidate should detect via fresh claims
    // resolution and reject as claims_changed.
    const cached2: SessionAuth = { kind: 'token', userId: 'alice', token: token2, claims: initialClaims };
    const r = await revalidateSessionAuth(store, cached2, token2, '127.0.0.1', '127.0.0.1');
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.body.error, 'claims_changed');
  });
});
