// executeForSession — generic entry helper for tRPC/MCP.
// Decides between plain executeAction (no scope) and executeWithCapability (workload).
// Branching is on session.scopeRef presence — NEVER on userId-pattern.

import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { withAcl } from '@treenx/core/security';
import { OpError } from '@treenx/core/errors';
import { createNode, register, R, W } from '@treenx/core';
import { clearRegistry } from '@treenx/core/testing';
import type { ActionCtx } from '@treenx/core/server/actions';
import type { Session } from '@treenx/core/security';
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

  it('wire opId becomes actor.requestId; retry with the same opId applies once (core-anz4.13)', async () => {
    registerThing();
    let runs = 0;
    let captured: unknown = null;
    register('thing', 'action:allowed', (ctx: ActionCtx) => { runs++; captured = ctx.actor; return runs; });

    const tree = await makeTree();
    const session: Session = { userId: 'agent:bot' };
    const opId = 'op-anz413-plain';
    const first = await executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'allowed', opId });
    const replay = await executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'allowed', opId });

    assert.equal((captured as { requestId?: string }).requestId, opId, 'audit actor carries the wire opId');
    assert.equal(runs, 1, 'replay must not apply a second time');
    assert.equal(first, 1);
    assert.equal(replay, 1, 'replay returns the first result');
  });

  it('stamps session.onBehalfOf onto actor; undefined when session lacks it', async () => {
    registerThing();
    let captured: unknown = null;
    register('thing', 'action:allowed', (ctx: ActionCtx) => { captured = ctx.actor; });

    const tree = await makeTree();
    const withHuman: Session = { userId: 'agent:bot', onBehalfOf: 'kriz' };
    await executeForSession(aclWrap(tree), withHuman, { path: '/work/n', action: 'allowed' });
    const actor = captured as { onBehalfOf?: string };
    assert.equal(actor.onBehalfOf, 'kriz');

    captured = null;
    const bare: Session = { userId: 'agent:bot' };
    await executeForSession(aclWrap(tree), bare, { path: '/work/n', action: 'allowed' });
    const plainActor = captured as { onBehalfOf?: string };
    assert.equal(plainActor.onBehalfOf, undefined);
  });
});

describe('executeForSession — scoped (workload)', () => {
  async function setupScoped(allowed: string[]) {
    const tree = await makeTree();
    await tree.set({ $path: '/agents', $type: 'dir' });
    await tree.set(createNode('/agents/bot', 't.agent.port', undefined, {
      scope: defineAgentScope({
        plan: { read: ['/work/*'], write: [], exec: [] },
        work: { read: ['/work/*'], write: ['/work/*'], exec: allowed },
      }),
    }));
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

  it('workload lane threads opId: actor.requestId set, retry idempotent (core-anz4.13)', async () => {
    registerThing();
    let runs = 0;
    let captured: unknown = null;
    register('thing', 'action:allowed', (ctx: ActionCtx) => { runs++; captured = ctx.actor; return runs; });

    const tree = await setupScoped(['allowed']);
    const session: Session = {
      userId: 'agent-workload:r-1',
      scopeRef: '/agents/bot', scopeKey: 'scope', scopeMode: 'work',
    };
    const opId = 'op-anz413-scoped';
    const first = await executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'allowed', opId });
    const replay = await executeForSession(aclWrap(tree), session, { path: '/work/n', action: 'allowed', opId });

    assert.equal((captured as { requestId?: string }).requestId, opId);
    assert.equal(runs, 1, 'capability lane must dedupe the retry too');
    assert.equal(first, 1);
    assert.equal(replay, 1);
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
