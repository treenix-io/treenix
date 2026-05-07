// executeForSession — generic entry helper for tRPC/MCP.
// Decides between plain executeAction (no scope) and executeWithCapability (workload).
// Branching is on session.scopeRef presence — NEVER on userId-pattern.

import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { withAcl } from '@treenx/core/server/auth';
import { OpError } from '@treenx/core/errors';
import { register, R, W } from '@treenx/core';
import { clearRegistry } from '@treenx/core/core/index.test';
import type { ActionCtx } from '@treenx/core/server/actions';
import type { Session } from '@treenx/core/server/auth';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { defineAgentScope } from './capability';
import { executeForSession } from './session';

beforeEach(() => clearRegistry());

async function makeTree(): Promise<Tree> {
  const t = createMemoryTree();
  await t.set({ $path: '/', $type: 'root', $acl: [{ g: 'agent', p: R | W }] });
  await t.set({ $path: '/work', $type: 'dir' });
  await t.set({ $path: '/work/n', $type: 'thing' });
  return t;
}

function registerThing() {
  register('thing', 'schema', () => ({
    $id: 'thing', title: 'T', type: 'object' as const, properties: {},
    methods: { allowed: { arguments: [] }, denied: { arguments: [] } },
  }));
}

const aclWrap = (t: Tree) => withAcl(t, 'agent:bot', ['agent']);

describe('executeForSession — no scope', () => {
  it('plain session → executeAction with actor built from session', async () => {
    registerThing();
    let captured: unknown = null;
    register('thing', 'action:allowed', (ctx: ActionCtx) => { captured = ctx.actor; });

    const tree = await makeTree();
    const session: Session = { userId: 'agent:bot', taskPath: '/board/tasks/1' };
    await executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'allowed' });

    const actor = captured as { id: string; taskPath?: string; action?: string; requestId?: string };
    assert.equal(actor.id, 'agent:bot');
    assert.equal(actor.taskPath, '/board/tasks/1');
    assert.equal(actor.action, 'allowed');
    assert.ok(actor.requestId, 'requestId auto-generated per call');
  });
});

describe('executeForSession — scoped (workload)', () => {
  async function setupScoped(allowed: string[]) {
    const tree = await makeTree();
    await tree.set({ $path: '/agents', $type: 'dir' });
    await tree.set({ $path: '/agents/bot', $type: 't.agent.port',
      scope: defineAgentScope({
        plan: { read: ['/work/*'], write: [], exec: [] },
        work: { read: ['/work/*'], write: ['/work/*'], exec: allowed },
      }),
    });
    return tree;
  }

  it('scopeRef + mode=work: action in allowedExec passes', async () => {
    registerThing();
    let captured: unknown = null;
    register('thing', 'action:allowed', (ctx: ActionCtx) => { captured = ctx.actor; });

    const tree = await setupScoped(['allowed']);
    const session: Session = {
      userId: 'agent-workload:r-1',
      taskPath: '/board/tasks/1',
      runPath: '/agents/bot/runs/r-1',
      scopeRef: '/agents/bot',
      scopeKey: 'scope',
      scopeMode: 'work',
    };
    await executeForSession(aclWrap(tree), session,
      { path: '/work/n', action: 'allowed' });
    assert.ok(captured, 'handler ran');
  });

  it('scopeRef + mode=work: action NOT in allowedExec rejected', async () => {
    registerThing();
    register('thing', 'action:denied', () => {});
    const tree = await setupScoped(['allowed']);
    const session: Session = {
      userId: 'agent-workload:r-1',
      scopeRef: '/agents/bot', scopeKey: 'scope', scopeMode: 'work',
    };
    await assert.rejects(
      executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'denied' }),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('mode=plan denies mutating actions even when work would allow', async () => {
    registerThing();
    register('thing', 'action:allowed', () => {});
    const tree = await setupScoped(['allowed']);
    const session: Session = {
      userId: 'agent-workload:r-1',
      scopeRef: '/agents/bot', scopeKey: 'scope', scopeMode: 'plan',
    };
    await assert.rejects(
      executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'allowed' }),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('invalid scopeRef → FORBIDDEN', async () => {
    registerThing();
    const tree = await setupScoped(['allowed']);
    const session: Session = {
      userId: 'agent-workload:r-1',
      scopeRef: '/agents/missing', scopeKey: 'scope', scopeMode: 'work',
    };
    await assert.rejects(
      executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'allowed' }),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });
});
