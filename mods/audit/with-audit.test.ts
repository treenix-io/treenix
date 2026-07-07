// withAudit — Tree wrapper that appends an audit.event for every set/remove/patch.
// Synchronous in pipeline tick: if append fails, the original mutation also fails (loud).

import { R, register, W } from '@treenx/core';
import { registerType } from '@treenx/core/comp';
import { executeAction } from '@treenx/core/server/actions';
import { createPipeline } from '@treenx/core/server/server';
import { withAcl } from '@treenx/core/security';
import { asTreeSource, createMemoryTree, type Tree } from '@treenx/core/tree';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkHealth, isHealthy, resetHealthForTest } from './health';
import { auditExecHooks, withAudit } from './with-audit';

let inner: Tree;
let audited: Tree;

beforeEach(async () => {
  inner = createMemoryTree();
  await inner.set({ $path: '/', $type: 'root', $acl: [{ g: 'public', p: R | W }] });
  await inner.set({ $path: '/sys', $type: 'dir' });
  await inner.set({ $path: '/sys/audit', $type: 'dir' });
  await inner.set({ $path: '/sys/audit/event', $type: 'mount-point' });
  await inner.set({ $path: '/data', $type: 'dir' });
  audited = withAudit(inner);
});

afterEach(() => resetHealthForTest());

async function listAuditEvents(tree: Tree) {
  const { items } = await tree.getChildren('/sys/audit/event');
  return items;
}

describe('withAudit — set', () => {
  it('appends audit.event with op=set, path, before=undefined for new node', async () => {
    await audited.set({ $path: '/data/n', $type: 'thing', value: 1 });
    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'set');
    assert.equal(events[0].path, '/data/n');
    assert.equal(events[0].before, null);
    assert.deepEqual((events[0].after as any).value, 1);
  });

  it('captures before-image for existing node', async () => {
    await inner.set({ $path: '/data/n', $type: 'thing', value: 1 });
    await audited.set({ $path: '/data/n', $type: 'thing', value: 2 });
    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1);
    assert.equal((events[0].before as any).value, 1);
    assert.equal((events[0].after as any).value, 2);
  });

  it('extracts actor fields from ctx.actor', async () => {
    await audited.set({ $path: '/data/n', $type: 'thing' }, {
      actor: { id: 'agent-workload:r-1', taskPath: '/board/tasks/1', requestId: 'req-abc' },
    });
    const events = await listAuditEvents(inner);
    assert.equal(events[0].by, 'agent-workload:r-1');
    assert.equal(events[0].taskPath, '/board/tasks/1');
    assert.equal(events[0].requestId, 'req-abc');
  });
});

describe('withAudit — remove', () => {
  it('appends audit.event with op=remove and before-image', async () => {
    await inner.set({ $path: '/data/n', $type: 'thing', value: 42 });
    await audited.remove('/data/n');
    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'remove');
    assert.equal((events[0].before as any).value, 42);
    assert.equal(events[0].after, null);
  });
});

describe('withAudit — patch', () => {
  it('appends audit.event with op=patch and before/after', async () => {
    await inner.set({ $path: '/data/n', $type: 'thing', value: 1 });
    await audited.patch('/data/n', [['r', 'value', 99]]);
    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'patch');
    assert.equal((events[0].before as any).value, 1);
    assert.equal((events[0].after as any).value, 99);
  });
});

describe('withAudit — patchMany', () => {
  type AuditRow = {
    path: string;
    ops?: unknown;
    node?: { value?: unknown };
    before: { value?: unknown } | null;
    after: { value?: unknown; $rev?: unknown } | null;
  };

  it('one journal row covers the whole batch with per-member before/after images', async () => {
    await inner.set({ $path: '/data/a', $type: 'thing', value: 1 });
    await inner.set({ $path: '/data/b', $type: 'thing', value: 2 });
    assert.ok(audited.patchMany, 'audited tree exposes patchMany when the inner tree does');

    await audited.patchMany!('/data', [
      { path: '/data/a', ops: [['r', 'value', 10]] },
      { path: '/data/b', ops: [['r', 'value', 20]] },
    ], { actor: { id: 'u-alice', requestId: 'req-9' } });

    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1, 'one row for the whole batch');
    assert.equal(events[0].op, 'patchMany');
    assert.equal(events[0].path, '/data');
    assert.equal(events[0].by, 'u-alice');
    assert.equal(events[0].requestId, 'req-9');

    const rows = events[0].entries as AuditRow[]; // boundary decode: stored journal row
    assert.equal(rows.length, 2);
    assert.equal(rows[0].before?.value, 1);
    assert.equal(rows[0].after?.value, 10);
    assert.equal(rows[1].before?.value, 2);
    assert.equal(rows[1].after?.value, 20);
  });

  it('set-member (create) journals the node with before=null / after=stored', async () => {
    await inner.set({ $path: '/data/a', $type: 'thing', value: 1 });

    await audited.patchMany!('/data', [
      { path: '/data/a', ops: [['r', 'value', 2]] },
      { path: '/data/new', node: { $path: '/data/new', $type: 'thing', value: 7 } },
    ]);

    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1, 'still one row for the whole batch');
    const rows = events[0].entries as AuditRow[]; // boundary decode: stored journal row
    assert.equal(rows.length, 2);

    const setRow = rows[1];
    assert.equal(setRow.path, '/data/new');
    assert.equal('ops' in setRow, false, 'set-member journals the incoming node, not ops');
    assert.equal(setRow.node?.value, 7);
    assert.equal(setRow.before, null);
    assert.equal(setRow.after?.value, 7);
    assert.equal(typeof setRow.after?.$rev, 'number', 'after is the STORED image (rev bumped)');
  });

  it('failed batch appends nothing to the journal', async () => {
    await inner.set({ $path: '/data/a', $type: 'thing', value: 1 });

    await assert.rejects(
      audited.patchMany!('/data', [
        { path: '/data/a', ops: [['r', 'value', 10]] },
        { path: '/data/missing', ops: [['r', 'value', 1]] },
      ]),
    );

    assert.equal((await listAuditEvents(inner)).length, 0);
    const a = await inner.get('/data/a');
    assert.equal(a?.value, 1);
  });
});

describe('withAudit — recursion guard', () => {
  it('writes to /sys/audit/event/* pass through without recursive auditing', async () => {
    // Direct write to audit subtree should not produce another audit event
    await audited.set({ $path: '/sys/audit/event/manual', $type: 'audit.event', op: 'set', path: '/x' });
    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1, 'one event from the direct write, not a recursive one');
    assert.equal(events[0].$path, '/sys/audit/event/manual');
  });
});

describe('withAudit — loud failure', () => {
  it('audit append failure surfaces error AND marks server unhealthy', async () => {
    // Wrap inner so audit-event writes throw, ordinary writes succeed
    const failOnAudit: Tree = {
      ...inner,
      async set(node, ctx) {
        if (node.$path.startsWith('/sys/audit/event/')) {
          throw new Error('audit backend down');
        }
        return inner.set(node, ctx);
      },
    };
    const wrapped = withAudit(failOnAudit);
    await assert.rejects(
      wrapped.set({ $path: '/data/n', $type: 'thing', value: 1 }),
      (e: any) => e instanceof Error && /audit/i.test(e.message),
    );
    assert.equal(isHealthy(), false, 'health flag flipped on audit failure');
  });

  it('auto-heals: a successful append after an outage restores health (core-98jr)', async () => {
    let backendDown = true;
    const flaky: Tree = {
      ...inner,
      async set(node, ctx) {
        if (backendDown && node.$path.startsWith('/sys/audit/event/')) {
          throw new Error('audit backend down');
        }
        return inner.set(node, ctx);
      },
    };
    const wrapped = withAudit(flaky);

    await assert.rejects(wrapped.set({ $path: '/data/a', $type: 'thing', value: 1 }));
    assert.equal(isHealthy(), false, 'unhealthy while backend down');

    backendDown = false;
    await wrapped.set({ $path: '/data/a', $type: 'thing', value: 2 });
    assert.equal(isHealthy(), true, 'healed by the successful append');
  });

  it('recovery probe: checkHealth appends for real and heals while gated (core-98jr)', async () => {
    let backendDown = true;
    const flaky: Tree = {
      ...inner,
      async set(node, ctx) {
        if (backendDown && node.$path.startsWith('/sys/audit/event/')) {
          throw new Error('audit backend down');
        }
        return inner.set(node, ctx);
      },
    };
    const wrapped = withAudit(flaky); // registers the probe
    await assert.rejects(wrapped.set({ $path: '/data/b', $type: 'thing', value: 1 }));
    assert.equal(isHealthy(), false);

    backendDown = false;
    const state = await checkHealth();
    assert.equal(state.healthy, true, 'probe append healed the flag');

    // The probe row landed in the journal — the recovery is itself audited.
    const events = await inner.getChildren('/sys/audit/event');
    assert.ok(events.items.some(e => e.op === 'probe'), 'probe event recorded');
  });
});

describe('withAudit — read/traversal/subscription pass-through', () => {
  it('forwards scanChildren so the audited tree works as a read-runtime source', async () => {
    await inner.set({ $path: '/data/a', $type: 'thing' });
    await inner.set({ $path: '/data/b', $type: 'thing' });
    // Regression: withAudit hand-listed its methods and dropped scanChildren,
    // so asTreeSource threw "Tree does not expose scanChildren" for every
    // service (MCP list_children, etc.) reading through the production audit wrap.
    assert.ok(audited.scanChildren, 'audited tree must expose scanChildren');
    const source = asTreeSource(audited);
    const paths: string[] = [];
    for await (const entry of source.scanChildren('/data')) paths.push(entry.node.$path);
    assert.deepEqual(paths.sort(), ['/data/a', '/data/b']);
  });

  it('forwards watch when the inner tree exposes it', () => {
    const withWatch: Tree = { ...inner, watch: () => (async function* () {})() };
    assert.ok(withAudit(withWatch).watch, 'audited tree must forward watch');
  });
});

describe('audit pipeline wiring (core-dpp)', () => {
  it('audits user writes through the router-facing pipeline.tree, not writes below the wrap', async () => {
    const bootstrap = createMemoryTree();
    await bootstrap.set({ $path: '/', $type: 'root' });
    await bootstrap.set({ $path: '/sys', $type: 'dir' });
    await bootstrap.set({ $path: '/sys/audit', $type: 'dir' });
    await bootstrap.set({ $path: '/sys/audit/event', $type: 'dir' });
    await bootstrap.set({ $path: '/data', $type: 'dir' });
    const pipeline = createPipeline(bootstrap, {}, withAudit);

    // The tRPC router and every per-user withAcl wrap pipeline.tree, so a user write
    // through it MUST be audited. Bug (core-dpp): the router saw the un-audited tree
    // because wrapTree was applied later, in factory, after the router was built.
    await pipeline.tree.set({ $path: '/data/x', $type: 'thing', value: 1 });
    const events = (await pipeline.tree.getChildren('/sys/audit/event')).items;
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'set');
    assert.equal(events[0].path, '/data/x');

    // Writes below the wrap (where boot seed/log/autostart go) are NOT audited.
    await pipeline.mountable.set({ $path: '/data/y', $type: 'thing' });
    assert.equal((await pipeline.tree.getChildren('/sys/audit/event')).items.length, 1);
  });

  it('is a no-op when wrapTree is absent (audit off = zero overhead)', async () => {
    const bootstrap = createMemoryTree();
    await bootstrap.set({ $path: '/data', $type: 'dir' });
    const pipeline = createPipeline(bootstrap, {});
    await pipeline.tree.set({ $path: '/data/x', $type: 'thing', value: 7 });
    const node = await pipeline.tree.get('/data/x');
    assert.equal(node?.value, 7);
  });

  // core-gk8.5 (attribution slice): the action commit threads opts.actor into
  // the write ctx, so the journal answers WHO — not just what.
  it('action commits are attributed: event carries by/action/requestId from opts.actor', async () => {
    registerType('audittest.counter', class { count = 0; bump() { this.count++; } });
    register('audittest.counter', 'schema', () => ({
      $id: 'audittest.counter',
      type: 'object',
      properties: { count: { type: 'integer' } },
      methods: { bump: { arguments: [] } },
    }));
    await audited.set({ $path: '/data/c1', $type: 'audittest.counter', count: 0 });

    const actor = { id: 'u-alice', action: 'bump', requestId: 'req-42' };
    await executeAction(audited, '/data/c1', undefined, undefined, 'bump', undefined, { actor });

    const events = await listAuditEvents(audited);
    const patchEvent = events.find(e => e.op === 'patch' && e.path === '/data/c1');
    assert.ok(patchEvent, 'action commit journaled');
    assert.equal(patchEvent!.by, 'u-alice');
    assert.equal(patchEvent!.action, 'bump');
    assert.equal(patchEvent!.requestId, 'req-42');
  });
});

// core-3j54: withAcl is where principal identity binds, so it default-stamps
// ctx.actor on every mutation it forwards — direct verbs (tRPC/TWP set/patch/rm,
// setComponent, deployPrefab, MCP set_node) land attributed without any
// caller-threaded ctx. Caller-supplied actor (richer, from the executor) wins.
describe('actor stamping at the ACL boundary (core-3j54)', () => {
  const acl = () => withAcl(audited, 'alice', ['public']);

  it('direct set/patch/remove through withAcl land with by=userId', async () => {
    const user = acl();
    await user.set({ $path: '/data/n', $type: 'thing', value: 1 });
    await user.patch('/data/n', [['r', 'value', 2]]);
    await user.remove('/data/n');

    const events = await listAuditEvents(inner);
    assert.equal(events.length, 3);
    for (const ev of events) assert.equal(ev.by, 'alice');
  });

  it('opId rides onto the default actor as requestId', async () => {
    await acl().set({ $path: '/data/n', $type: 'thing' }, { opId: 'op-7' });
    const [ev] = await listAuditEvents(inner);
    assert.equal(ev.by, 'alice');
    assert.equal(ev.requestId, 'op-7');
  });

  it('caller-supplied actor wins over the default stamp', async () => {
    await acl().set({ $path: '/data/n', $type: 'thing' }, {
      actor: { id: 'agent-workload:r-1', action: 'run', onBehalfOf: 'kriz' },
    });
    const [ev] = await listAuditEvents(inner);
    assert.equal(ev.by, 'agent-workload:r-1');
    assert.equal(ev.action, 'run');
    assert.equal(ev.onBehalfOf, 'kriz');
  });

  it('patchMany through withAcl is attributed', async () => {
    await inner.set({ $path: '/data/a', $type: 'thing', value: 1 });
    const user = acl();
    assert.ok(user.patchMany, 'acl tree forwards patchMany');
    await user.patchMany!('/data', [
      { path: '/data/a', ops: [['r', 'value', 2]] },
      { path: '/data/b', node: { $path: '/data/b', $type: 'thing', value: 3 } },
    ]);
    const [ev] = await listAuditEvents(inner);
    assert.equal(ev.op, 'patchMany');
    assert.equal(ev.by, 'alice');
  });

  it('journal is queryable by actor: getChildren query {by}', async () => {
    await withAcl(audited, 'alice', ['public']).set({ $path: '/data/a', $type: 'thing' });
    await withAcl(audited, 'bob', ['public']).set({ $path: '/data/b', $type: 'thing' });

    const page = await withAcl(audited, 'reader', ['public'])
      .getChildren('/sys/audit/event', { query: { by: 'alice' } });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].path, '/data/a');
  });
});

describe('auditExecHooks — delegation journal (core-pa3m)', () => {
  it('onDelegating appends a delegate intent row with by/action/requestId', async () => {
    const hooks = auditExecHooks(inner);

    await hooks.onDelegating!({ path: '/fed/w', action: 'bump', userId: 'u-alice', opId: 'op-7' });

    const events = await listAuditEvents(inner);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'delegate');
    assert.equal(events[0].path, '/fed/w');
    assert.equal(events[0].action, 'bump');
    assert.equal(events[0].by, 'u-alice');
    assert.equal(events[0].requestId, 'op-7');
  });

  it('onDelegatedSettled appends outcome; failure carries the error message', async () => {
    const hooks = auditExecHooks(inner);

    await hooks.onDelegatedSettled!({ path: '/fed/w', action: 'bump', userId: 'u-alice', ok: true });
    await hooks.onDelegatedSettled!({ path: '/fed/w', action: 'bump', userId: 'u-alice', ok: false, error: new Error('remote refused') });

    const events = await listAuditEvents(inner);
    assert.equal(events.length, 2);
    assert.equal(events[0].op, 'delegate-settled');
    assert.equal(events[0].ok, true);
    assert.equal(events[1].ok, false);
    assert.equal(events[1].error, 'remote refused');
  });

  it('intent append failure REJECTS (withExecute aborts the delegation) and marks unhealthy', async () => {
    const failOnAudit: Tree = {
      ...inner,
      async set(node, ctx) {
        if (node.$path.startsWith('/sys/audit/event/')) throw new Error('audit backend down');
        return inner.set(node, ctx);
      },
    };
    const hooks = auditExecHooks(failOnAudit);

    await assert.rejects(
      async () => hooks.onDelegating!({ path: '/fed/w', action: 'bump', userId: 'u-alice' }),
      (e: unknown) => e instanceof Error && /audit/i.test(e.message),
    );
    assert.equal(isHealthy(), false, 'health flag flipped on intent append failure');
  });
});
