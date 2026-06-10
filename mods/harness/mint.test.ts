// mintWorkloadToken — creates a per-run workload session bound to agent-port scope.
// Output: bearer token + session path. Session metadata: actorId, taskPath, runPath,
// scopeRef, scopeKey, scopeMode='plan'. Admin-only session ACL prevents workload
// from tampering with its own scope.

import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { resolveToken } from '@treenx/core/security/auth';
import { OpError } from '@treenx/core/errors';
import { getComponentByName, R, W, A, S } from '@treenx/core';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { defineAgentScope } from './capability';
import { mintWorkloadToken } from './mint';

let tree: Tree;

beforeEach(async () => {
  tree = createMemoryTree();
  await tree.set({ $path: '/', $type: 'root' });
  await tree.set({ $path: '/auth', $type: 'dir' });
  await tree.set({ $path: '/auth/users', $type: 'dir' });
  await tree.set({ $path: '/auth/sessions', $type: 'dir' });
  await tree.set({ $path: '/agents', $type: 'dir' });
  await tree.set({
    $path: '/agents/bot', $type: 't.agent.port',
    '#scope': defineAgentScope({
      plan: { read: ['/work/*'], write: ['/agents/bot/runs/*'], exec: ['ai.plan.*'] },
      work: { read: ['/work/*'], write: ['/work/*'], exec: ['refund.requestReview'] },
    }),
  });
  await tree.set({ $path: '/agents/scopeless', $type: 't.agent.port' });
});

describe('mintWorkloadToken', () => {
  it('creates session that resolves with workload metadata', async () => {
    const { token } = await mintWorkloadToken(tree, {
      agentPath: '/agents/bot',
      taskPath: '/board/tasks/4521',
      runPath: '/agents/bot/runs/r-1',
    });
    const session = await resolveToken(tree, token) as Record<string, unknown> | null;
    assert.ok(session);
    assert.equal(session?.userId, 'agent-workload:r-1');
    assert.equal(session?.taskPath, '/board/tasks/4521');
    assert.equal(session?.runPath, '/agents/bot/runs/r-1');
    assert.equal(session?.scopeRef, '/agents/bot');
    assert.equal(session?.scopeKey, 'scope');
    assert.equal(session?.scopeMode, 'plan'); // always starts in plan
  });

  it('creates agent-workload user with single group "agent-workload"', async () => {
    await mintWorkloadToken(tree, {
      agentPath: '/agents/bot',
      taskPath: '/board/tasks/1',
      runPath: '/agents/bot/runs/r-2',
    });
    const userNode = await tree.get('/auth/users/agent-workload:r-2');
    assert.ok(userNode, 'user node exists');
    const groupsRaw = getComponentByName(userNode!, 'groups') as Record<string, unknown> | undefined;
    assert.deepEqual(groupsRaw?.list, ['agent-workload'], 'no admin/authenticated leakage');
  });

  it('throws if agent-port has no scope component', async () => {
    await tree.set({ $path: '/agents/no-scope', $type: 't.agent.port' });
    await assert.rejects(
      mintWorkloadToken(tree, {
        agentPath: '/agents/no-scope',
        taskPath: '/board/tasks/1',
        runPath: '/agents/no-scope/runs/r-3',
      }),
      (e: any) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('throws if agent-port does not exist', async () => {
    await assert.rejects(
      mintWorkloadToken(tree, {
        agentPath: '/agents/missing',
        taskPath: '/board/tasks/1',
        runPath: '/agents/missing/runs/r-4',
      }),
      (e: any) => e instanceof OpError && e.code === 'NOT_FOUND',
    );
  });

  it('extracts runId from runPath (last segment)', async () => {
    const { token } = await mintWorkloadToken(tree, {
      agentPath: '/agents/bot',
      taskPath: '/board/tasks/1',
      runPath: '/agents/bot/runs/r-99',
    });
    const session = await resolveToken(tree, token) as Record<string, unknown> | null;
    assert.equal(session?.userId, 'agent-workload:r-99');
  });

  it('branch is a valid boundary on its own: scope-less port mints a branch-rooted session', async () => {
    const { token } = await mintWorkloadToken(tree, {
      agentPath: '/agents/scopeless',
      taskPath: '/board/tasks/1',
      runPath: '/agents/scopeless/runs/r-7',
      branch: '/branches/b-7',
    });
    const session = await resolveToken(tree, token) as Record<string, unknown> | null;
    assert.equal(session?.branch, '/branches/b-7');
    assert.equal(session?.scopeRef, undefined, 'no capability scope without a scope component');
  });

  it('scope-less port without a branch still fails loud', async () => {
    await assert.rejects(
      mintWorkloadToken(tree, {
        agentPath: '/agents/scopeless',
        taskPath: '/board/tasks/1',
        runPath: '/agents/scopeless/runs/r-8',
      }),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('scoped port with a branch carries both boundaries', async () => {
    const { token } = await mintWorkloadToken(tree, {
      agentPath: '/agents/bot',
      taskPath: '/board/tasks/1',
      runPath: '/agents/bot/runs/r-9',
      branch: '/branches/b-9',
    });
    const session = await resolveToken(tree, token) as Record<string, unknown> | null;
    assert.equal(session?.branch, '/branches/b-9');
    assert.equal(session?.scopeRef, '/agents/bot');
  });
});
