import { createNode } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type NodeEvent, withSubscriptions } from './sub';

describe('Subscriptions', () => {
  it('emits on set (children)', async () => {
    const store = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    store.subscribe('/bot', (e) => events.push(e), { children: true });

    await store.set(createNode('/bot/commands/start', 'page'));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'set');
    assert.equal(events[0].path, '/bot/commands/start');
  });

  it('emits on remove (children)', async () => {
    const store = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    await store.set(createNode('/bot/x', 'page'));
    store.subscribe('/bot', (e) => events.push(e), { children: true });
    await store.remove('/bot/x');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
  });

  it('does not emit for unrelated paths', async () => {
    const store = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    store.subscribe('/bot', (e) => events.push(e), { children: true });
    await store.set(createNode('/users/1', 'user'));
    assert.equal(events.length, 0);
  });

  it('emits for exact path match', async () => {
    const store = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    store.subscribe('/bot', (e) => events.push(e));
    await store.set(createNode('/bot', 'bot'));
    assert.equal(events.length, 1);
  });

  it('unsubscribe stops events (children)', async () => {
    const store = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    const unsub = store.subscribe('/bot', (e) => events.push(e), { children: true });
    await store.set(createNode('/bot/x', 'page'));
    assert.equal(events.length, 1);
    unsub();
    await store.set(createNode('/bot/y', 'page'));
    assert.equal(events.length, 1);
  });
});
