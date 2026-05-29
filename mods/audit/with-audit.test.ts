// withAudit — Tree wrapper that appends an audit.event for every set/remove/patch.
// Synchronous in pipeline tick: if append fails, the original mutation also fails (loud).

import { R, W } from '@treenx/core';
import { createPipeline } from '@treenx/core/server/server';
import { asTreeSource, createMemoryTree, type Tree } from '@treenx/core/tree';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isHealthy, resetHealthForTest } from './health';
import { withAudit } from './with-audit';

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
});
