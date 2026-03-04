import { createNode, R, S, W } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AGENT_SESSION_TTL, hashAgentKey, timingSafeCompare } from './agent';
import { buildClaims, createSession, resolveToken, withAcl } from './auth';

// Import agent-port type registration (side-effect: registers t.agent.port)
import '../mods/treenity/agent-port';

let store: Tree;

beforeEach(async () => {
  clearRegistry();
  // Re-import registers via dynamic import won't re-run, so import at top level
  await import('../mods/treenity/agent-port');

  store = createMemoryTree();
  // Root with public read
  await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }] });
});

describe('hashAgentKey', () => {
  it('produces consistent SHA-256 hex', () => {
    const h1 = hashAgentKey('test-secret');
    const h2 = hashAgentKey('test-secret');
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 = 32 bytes = 64 hex chars
  });

  it('different keys produce different hashes', () => {
    assert.notEqual(hashAgentKey('key-a'), hashAgentKey('key-b'));
  });
});

describe('timingSafeCompare', () => {
  it('returns true for matching hashes', () => {
    const h = hashAgentKey('secret');
    assert.equal(timingSafeCompare(h, h), true);
  });

  it('returns false for different hashes', () => {
    assert.equal(timingSafeCompare(hashAgentKey('a'), hashAgentKey('b')), false);
  });

  it('returns false for different lengths', () => {
    assert.equal(timingSafeCompare('aa', 'bbbb'), false);
  });
});

describe('agent session', () => {
  it('createSession with custom TTL', async () => {
    const token = await createSession(store, 'agent:/agents/bot', { ttlMs: AGENT_SESSION_TTL });
    assert.ok(token);
    const session = await resolveToken(store, token);
    assert.ok(session);
    assert.equal(session.userId, 'agent:/agents/bot');
  });

  it('createSession with custom claims stores and retrieves them', async () => {
    const claims = ['u:agent:/agents/bot', 'agent'];
    const token = await createSession(store, 'agent:/agents/bot', { claims });
    const session = await resolveToken(store, token);
    assert.ok(session);
    assert.deepEqual(session.claims, claims);
  });

  it('regular session has no claims field', async () => {
    const token = await createSession(store, 'alice');
    const session = await resolveToken(store, token);
    assert.ok(session);
    assert.equal(session.claims, undefined);
  });
});

describe('agent TOFU flow', () => {
  const PORT_PATH = '/agents/test-bot';
  const AGENT_KEY = 'super-secret-agent-key-12345';

  beforeEach(async () => {
    // Create agent port node (admin action)
    await store.set({
      ...createNode(PORT_PATH, 't.agent.port'),
      label: 'Test Bot',
      status: 'idle',
      connected: false,
      $acl: [{ g: 'admins', p: R | W | S }],
    });
  });

  it('idle → pending on first connect', async () => {
    const keyHash = hashAgentKey(AGENT_KEY);
    const node = await store.get(PORT_PATH);
    assert.ok(node);

    // Simulate agentConnect: idle → pending
    await store.set({ ...node, status: 'pending', pendingKey: keyHash });

    const updated = await store.get(PORT_PATH);
    assert.equal((updated as any).status, 'pending');
    assert.equal((updated as any).pendingKey, keyHash);
  });

  it('pending + same key = still pending', async () => {
    const keyHash = hashAgentKey(AGENT_KEY);
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'pending',
      pendingKey: keyHash,
    });

    // Same key: verify it matches
    assert.ok(timingSafeCompare(hashAgentKey(AGENT_KEY), keyHash));
  });

  it('pending + different key = rejected', async () => {
    const keyHash = hashAgentKey(AGENT_KEY);
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'pending',
      pendingKey: keyHash,
    });

    // Different key doesn't match
    assert.equal(timingSafeCompare(hashAgentKey('wrong-key'), keyHash), false);
  });

  it('approve moves pending → approved, creates user, sets ACL', async () => {
    const keyHash = hashAgentKey(AGENT_KEY);
    const agentUserId = `agent:${PORT_PATH}`;

    // Set to pending
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'pending',
      pendingKey: keyHash,
    });

    // Simulate approve action effects
    const node = (await store.get(PORT_PATH))!;
    const acl = [...(node.$acl ?? []), { g: `u:${agentUserId}`, p: R | W | S }];
    await store.set({
      ...node,
      status: 'approved',
      approvedKey: keyHash,
      pendingKey: undefined,
      $acl: acl,
    });

    // Create agent user
    await store.set({
      ...createNode(`/auth/users/${agentUserId}`, 'user'),
      groups: { $type: 'groups', list: ['agent'] },
    });

    // Verify
    const approved = await store.get(PORT_PATH);
    assert.equal((approved as any).status, 'approved');
    assert.equal((approved as any).approvedKey, keyHash);
    assert.equal((approved as any).pendingKey, undefined);

    const user = await store.get(`/auth/users/${agentUserId}`);
    assert.ok(user);

    // Agent ACL is set
    assert.ok(approved!.$acl?.some(e => e.g === `u:${agentUserId}` && e.p === (R | W | S)));
  });

  it('approved + correct key = session with agent userId', async () => {
    const keyHash = hashAgentKey(AGENT_KEY);
    const agentUserId = `agent:${PORT_PATH}`;

    // Setup approved state
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'approved',
      approvedKey: keyHash,
      $acl: [
        { g: 'admins', p: R | W | S },
        { g: `u:${agentUserId}`, p: R | W | S },
      ],
    });
    await store.set({
      ...createNode(`/auth/users/${agentUserId}`, 'user'),
      groups: { $type: 'groups', list: ['agent'] },
    });

    // Agent connects with correct key
    assert.ok(timingSafeCompare(hashAgentKey(AGENT_KEY), keyHash));

    // Create session
    const token = await createSession(store, agentUserId, { ttlMs: AGENT_SESSION_TTL });
    const session = await resolveToken(store, token);
    assert.ok(session);
    assert.equal(session.userId, agentUserId);

    // buildClaims includes 'agent' group
    const claims = await buildClaims(store, agentUserId);
    assert.ok(claims.includes(`u:${agentUserId}`));
    assert.ok(claims.includes('authenticated'));
    assert.ok(claims.includes('agent'));
  });

  it('agent can write to its subtree via ACL', async () => {
    const agentUserId = `agent:${PORT_PATH}`;
    const claims = [`u:${agentUserId}`, 'authenticated', 'agent'];

    // Setup: agent port with ACL granting agent access
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'approved',
      $acl: [
        { g: 'admins', p: R | W | S },
        { g: `u:${agentUserId}`, p: R | W | S },
      ],
    });

    const aclStore = withAcl(store, agentUserId, claims);

    // Agent can write to its subtree
    await aclStore.set(createNode(`${PORT_PATH}/state`, 'agent.state'));
    const child = await aclStore.get(`${PORT_PATH}/state`);
    assert.ok(child);
    assert.equal(child.$type, 'agent.state');
  });

  it('agent cannot write outside its subtree', async () => {
    const agentUserId = `agent:${PORT_PATH}`;
    const claims = [`u:${agentUserId}`, 'authenticated', 'agent'];

    // Setup
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'approved',
      $acl: [
        { g: 'admins', p: R | W | S },
        { g: `u:${agentUserId}`, p: R | W | S },
      ],
    });

    const aclStore = withAcl(store, agentUserId, claims);

    // Agent cannot write to root-level paths (root ACL: public R only)
    await assert.rejects(
      () => aclStore.set(createNode('/something-else', 'dir')),
      (err: Error) => err.message.includes('Access denied'),
    );
  });

  it('revoke clears access', async () => {
    const agentUserId = `agent:${PORT_PATH}`;

    // Setup approved state with ACL
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'approved',
      approvedKey: hashAgentKey(AGENT_KEY),
      $acl: [
        { g: 'admins', p: R | W | S },
        { g: `u:${agentUserId}`, p: R | W | S },
      ],
    });

    // Simulate revoke: clear key, remove agent ACL
    const node = (await store.get(PORT_PATH))!;
    const acl = (node.$acl ?? []).filter(e => e.g !== `u:${agentUserId}`);
    await store.set({
      ...node,
      status: 'revoked',
      approvedKey: undefined,
      connected: false,
      $acl: acl,
    });

    const revoked = await store.get(PORT_PATH);
    assert.equal((revoked as any).status, 'revoked');
    assert.equal((revoked as any).approvedKey, undefined);
    assert.ok(!revoked!.$acl?.some(e => e.g === `u:${agentUserId}`));
  });

  it('reset returns to idle', async () => {
    const agentUserId = `agent:${PORT_PATH}`;

    // Start from revoked
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'revoked',
      $acl: [{ g: 'admins', p: R | W | S }],
    });

    // Simulate reset
    await store.set({
      ...(await store.get(PORT_PATH))!,
      status: 'idle',
      pendingKey: undefined,
      approvedKey: undefined,
      connected: false,
      connectedAt: undefined,
    });

    const reset = await store.get(PORT_PATH);
    assert.equal((reset as any).status, 'idle');
  });
});
