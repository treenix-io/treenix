import { A, createNode, R } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type NodeEvent, withSubscriptions } from './index';
import { createWatchManager } from './watch';

describe('Subscriptions', () => {
  it('emits on set (children)', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });

    await tree.set(createNode('/bot/commands/start', 'page'));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'set');
    assert.equal(events[0].path, '/bot/commands/start');
  });

  it('emits on remove (children)', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    await tree.set(createNode('/bot/x', 'page'));
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.remove('/bot/x');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
  });

  it('does not emit for unrelated paths', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.set(createNode('/users/1', 'user'));
    assert.equal(events.length, 0);
  });

  it('emits for exact path match', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e));
    await tree.set(createNode('/bot', 'bot'));
    assert.equal(events.length, 1);
  });

  it('unsubscribe stops events (children)', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    const unsub = cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.set(createNode('/bot/x', 'page'));
    assert.equal(events.length, 1);
    unsub();
    await tree.set(createNode('/bot/y', 'page'));
    assert.equal(events.length, 1);
  });

  it('set with changed field emits computed patch', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    await tree.set({ ...createNode('/x', 'test'), foo: 'old' });
    cdc.subscribe('/x', (e) => events.push(e));

    // Client set: no patches → sub.ts computes diff via fast-json-patch
    await tree.set({ ...createNode('/x', 'test'), foo: 'new' });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'patch');
    if (events[0].type === 'patch') {
      const fooOp = events[0].patches.find(p => p.path === '/foo');
      assert.ok(fooOp);
      assert.equal((fooOp as any).value, 'new');
    }
  });

  it('string $patches are stripped and ignored — injection blocked', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    await tree.set({ ...createNode('/x', 'test'), amount: 100 });
    cdc.subscribe('/x', (e) => events.push(e));

    // Simulate client injection: string $patches with fake values
    const node: any = { ...createNode('/x', 'test'), amount: 200 };
    node.$patches = [{ op: 'replace', path: ['amount'], value: 0 }];
    await tree.set(node);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'patch');
    if (events[0].type === 'patch') {
      const amountOp = events[0].patches.find(p => p.path === '/amount');
      assert.ok(amountOp);
      // Computed diff shows the REAL value (200), not the injected fake (0)
      assert.equal((amountOp as any).value, 200);
    }
  });

  it('string $patches are not persisted to storage', async () => {
    const mem = createMemoryTree();
    const { tree } = withSubscriptions(mem);

    const node: any = { ...createNode('/x', 'test'), foo: 'bar' };
    node.$patches = [{ op: 'replace', path: ['foo'], value: 'FAKE' }];
    await tree.set(node);

    const stored = await mem.get('/x');
    assert.ok(stored);
    assert.equal('$patches' in stored, false, '$patches should not be stored');
  });

  it('updates query watch match when vp and source stay the same', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    cdc.watchQuery('/views/status', '/items', { status: 'open' }, 'u1');
    cdc.watchQuery('/views/status', '/items', { status: 'closed' }, 'u1');

    await tree.set({ $path: '/items/1', $type: 'item', status: 'closed' });

    const event = events.find(e => e.type === 'set' && e.path === '/items/1');
    assert.ok(event);
    if (event.type !== 'set') throw new Error('expected set event');
    assert.deepEqual(event.addVps, ['/views/status']);
  });

  it('routes query watches per user while preserving legacy raw watchers', async () => {
    const watcher = createWatchManager();
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => watcher.notify(e));
    const legacyEvents: NodeEvent[] = [];
    const memberEvents: NodeEvent[] = [];
    const anonEvents: NodeEvent[] = [];

    watcher.connect('legacy-conn', 'legacy', e => legacyEvents.push(e));
    watcher.connect('member-conn', 'member', e => memberEvents.push(e));
    watcher.connect('anon-conn', 'anon', e => anonEvents.push(e));
    watcher.watch('legacy', ['/views/open'], { children: true });
    watcher.watch('member', ['/views/open'], { children: true });
    watcher.watch('anon', ['/views/open'], { children: true });

    await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | A }] });
    await tree.set({ ...createNode('/items', 'dir'), $acl: [{ g: 'public', p: R }] });

    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'legacy');
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'member', ['authenticated', 'public']);
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'anon', ['public']);

    await tree.set({
      ...createNode('/items/1', 'item'),
      status: 'open',
      $acl: [{ g: 'public', p: 0 }, { g: 'authenticated', p: R }],
    });

    assert.equal(legacyEvents.length, 1);
    assert.equal(memberEvents.length, 1);
    assert.equal(anonEvents.length, 0);
    assert.equal(legacyEvents[0].type, 'set');
    assert.equal(memberEvents[0].type, 'set');
    if (legacyEvents[0].type !== 'set' || memberEvents[0].type !== 'set') {
      throw new Error('expected set events');
    }
    assert.deepEqual(legacyEvents[0].addVps, ['/views/open']);
    assert.deepEqual(memberEvents[0].addVps, ['/views/open']);
  });
});
