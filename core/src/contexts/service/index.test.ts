import { createNode, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { withSubscriptions } from '#server/sub';
import { createMemoryTree, resolveRef } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type ServiceCtx, type ServiceHandle, startServices, type StoreEvent } from './index';

describe('resolveRef', () => {
  it('returns node as-is when not a ref', async () => {
    const store = createMemoryTree();
    const node = createNode('/a', 'dir');
    await store.set(node);
    assert.deepEqual(await resolveRef(store, node), node);
  });

  it('resolves ref to target node', async () => {
    const store = createMemoryTree();
    const target = createNode('/bot', 'bot');
    await store.set(target);
    const refNode = { $path: '/sys/autostart/bot', $type: 'ref', $ref: '/bot' } as any;
    await store.set(refNode);
    assert.deepEqual(await resolveRef(store, refNode), target);
  });

  it('throws on broken ref', async () => {
    const store = createMemoryTree();
    const refNode = { $path: '/sys/autostart/x', $type: 'ref', $ref: '/missing' } as any;
    await assert.rejects(() => resolveRef(store, refNode));
  });
});

describe('startServices', () => {
  beforeEach(() => clearRegistry());

  it('returns null when no autostart node', async () => {
    const store = createMemoryTree();
    assert.equal(await startServices(store, () => () => {}), null);
  });

  it('starts autostart service', async () => {
    let started = false,
      stopped = false;
    register('autostart', 'service', async () => {
      started = true;
      return {
        stop: async () => {
          stopped = true;
        },
      };
    });

    const store = createMemoryTree();
    await store.set(createNode('/sys/autostart', 'autostart'));
    const handle = await startServices(store, () => () => {});

    assert.equal(started, true);
    assert.ok(handle);
    await handle.stop();
    assert.equal(stopped, true);
  });

  it('autostart walks children and starts services', async () => {
    const log: string[] = [];

    register('autostart', 'service', async (node, ctx) => {
      const { items } = await ctx.store.getChildren(node.$path);
      const handles: ServiceHandle[] = [];
      for (const child of items) {
        const target = await resolveRef(ctx.store, child);
        const { resolve } = await import('#core');
        const handler = resolve(target.$type, 'service');
        if (!handler) continue;
        try {
          handles.push(await handler(target, ctx));
        } catch {}
      }
      return {
        stop: async () => {
          for (const h of handles) await h.stop();
        },
      };
    });

    register('echo', 'service', async (node) => {
      log.push(`start:${node.$path}`);
      return {
        stop: async () => {
          log.push(`stop:${node.$path}`);
        },
      };
    });

    const store = createMemoryTree();
    await store.set(createNode('/sys/autostart', 'autostart'));
    await store.set(createNode('/sys/autostart/a', 'echo'));
    const target = createNode('/srv/b', 'echo');
    await store.set(target);
    await store.set({ $path: '/sys/autostart/b', $type: 'ref', $ref: '/srv/b' } as any);

    const handle = await startServices(store, () => () => {})!;
    assert.deepEqual(log, ['start:/sys/autostart/a', 'start:/srv/b']);

    await handle!.stop();
    assert.deepEqual(log, [
      'start:/sys/autostart/a',
      'start:/srv/b',
      'stop:/sys/autostart/a',
      'stop:/srv/b',
    ]);
  });

  it('continues when one service fails to start', async () => {
    const log: string[] = [];

    register('autostart', 'service', async (node, ctx) => {
      const { items } = await ctx.store.getChildren(node.$path);
      const handles: ServiceHandle[] = [];
      for (const child of items) {
        const target = await resolveRef(ctx.store, child);
        const { resolve } = await import('#core');
        const handler = resolve(target.$type, 'service');
        if (!handler) continue;
        try {
          handles.push(await handler(target, ctx));
        } catch (e) {
          /* swallow */
        }
      }
      return {
        stop: async () => {
          for (const h of handles) await h.stop();
        },
      };
    });

    register('bad', 'service', async () => {
      throw new Error('boom');
    });
    register('good', 'service', async (node) => {
      log.push('started');
      return {
        stop: async () => {
          log.push('stopped');
        },
      };
    });

    const store = createMemoryTree();
    await store.set(createNode('/sys/autostart', 'autostart'));
    await store.set(createNode('/sys/autostart/a', 'bad'));
    await store.set(createNode('/sys/autostart/b', 'good'));

    const handle = await startServices(store, () => () => {});
    assert.deepEqual(log, ['started']);
    await handle!.stop();
    assert.deepEqual(log, ['started', 'stopped']);
  });
});

describe('ServiceCtx.subscribe', () => {
  beforeEach(() => clearRegistry());

  it('service receives subscribe in ctx', async () => {
    let receivedSubscribe = false;
    register('watcher', 'service', async (_node, ctx) => {
      receivedSubscribe = typeof ctx.subscribe === 'function';
      return { stop: async () => {} };
    });

    const store = createMemoryTree();
    await store.set(createNode('/sys/autostart', 'watcher'));
    await startServices(store, () => () => {});
    assert.equal(receivedSubscribe, true);
  });

  it('subscribe fires on set', async () => {
    const events: StoreEvent[] = [];
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); });

    const unsub = subscribe('/config/bot', (e) => events.push(e));

    await reactive.set(createNode('/config/bot', 'dir'));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'set');
    assert.equal(events[0].path, '/config/bot');

    unsub();
    await reactive.set({ ...createNode('/config/bot', 'dir'), name: 'changed' });
    assert.equal(events.length, 1, 'no events after unsub');
  });

  it('subscribe fires on remove', async () => {
    const events: StoreEvent[] = [];
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); });

    await reactive.set(createNode('/config/bot', 'dir'));
    subscribe('/config/bot', (e) => events.push(e));

    await reactive.remove('/config/bot');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
    assert.equal(events[0].path, '/config/bot');
  });

  it('subscribe fires patch on update', async () => {
    const events: StoreEvent[] = [];
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); });

    await reactive.set(createNode('/config/bot', 'dir'));
    subscribe('/config/bot', (e) => events.push(e));

    await reactive.set({ ...createNode('/config/bot', 'dir'), token: 'abc', $rev: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'patch');
    assert.equal(events[0].path, '/config/bot');
  });

  it('prefix subscribe catches children', async () => {
    const events: StoreEvent[] = [];
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb, opts) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); }, opts);

    subscribe('/config', (e) => events.push(e), { children: true });

    await reactive.set(createNode('/config/bot', 'dir'));
    await reactive.set(createNode('/config/db', 'dir'));
    assert.equal(events.length, 2);
    assert.equal(events[0].path, '/config/bot');
    assert.equal(events[1].path, '/config/db');
  });

  it('exact subscribe does NOT catch children', async () => {
    const events: StoreEvent[] = [];
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb, opts) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); }, opts);

    subscribe('/config', (e) => events.push(e));

    await reactive.set(createNode('/config/bot', 'dir'));
    assert.equal(events.length, 0, 'exact subscribe should not catch children');
  });

  it('does not fire for unrelated paths', async () => {
    const events: StoreEvent[] = [];
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); });

    subscribe('/config/bot', (e) => events.push(e));

    await reactive.set(createNode('/other/thing', 'dir'));
    assert.equal(events.length, 0);
  });

  it('service hot-reload: watches own config, reacts to admin update', async () => {
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb, opts) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); }, opts);

    // Seed bot config
    await reactive.set(createNode('/config/bot', 'bot-config', { token: 'old-token', lang: 'en' }));

    // Service starts and subscribes to its own config
    let reloadCount = 0;
    let lastEvent: StoreEvent | null = null;
    const unsub = subscribe('/config/bot', (e) => {
      reloadCount++;
      lastEvent = e;
    });

    // Admin updates bot token
    const node = (await reactive.get('/config/bot'))!;
    await reactive.set({ ...node, token: 'new-token' });
    assert.equal(reloadCount, 1);
    assert.equal(lastEvent!.type, 'patch');

    // Admin updates another field
    const node2 = (await reactive.get('/config/bot'))!;
    await reactive.set({ ...node2, lang: 'ru' });
    assert.equal(reloadCount, 2);

    // Service stops — unsubscribe
    unsub();
    const node3 = (await reactive.get('/config/bot'))!;
    await reactive.set({ ...node3, token: 'post-stop' });
    assert.equal(reloadCount, 2, 'no events after unsub');
  });

  it('service watches session dir for new users', async () => {
    const reactive = withSubscriptions(createMemoryTree());
    const subscribe: ServiceCtx['subscribe'] = (path, cb, opts) =>
      reactive.subscribe(path, (e) => { if ('path' in e) cb(e as StoreEvent); }, opts);

    await reactive.set(createNode('/sessions', 'dir'));

    // Service watches /sessions children for new logins
    const newSessions: string[] = [];
    const unsub = subscribe('/sessions', (e) => {
      if (e.type === 'set') newSessions.push(e.path);
    }, { children: true });

    // Users log in
    await reactive.set(createNode('/sessions/alice', 'session', { ts: 1 }));
    await reactive.set(createNode('/sessions/bob', 'session', { ts: 2 }));
    assert.deepEqual(newSessions, ['/sessions/alice', '/sessions/bob']);

    // Exact update to existing session — also caught by children watch
    const alice = (await reactive.get('/sessions/alice'))!;
    await reactive.set({ ...alice, lastSeen: 99 });
    assert.equal(newSessions.length, 2, 'patch events have type patch, not set');

    unsub();
  });
});
