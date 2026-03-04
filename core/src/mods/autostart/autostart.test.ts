// Autostart dynamic start/stop tests
// Tests: startService creates ref + starts, stopService removes ref + stops, boot walks children

import { startServices } from '#contexts/service/index';
import type { NodeData } from '#core';
import { createNode, register } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import real autostart module — registers 'autostart' type + service handler
import { startService, stopService } from './service';

// Register test service types once (sealed registry)
const svcLog: string[] = [];
register('test.autosvc', 'service', async (node) => {
  svcLog.push(`start:${node.$path}`);
  return { stop: async () => { svcLog.push(`stop:${node.$path}`); } };
});

describe('autostart dynamic start/stop', () => {
  async function boot() {
    svcLog.length = 0;
    const store = createMemoryTree();
    await store.set(createNode('/sys/autostart', 'autostart'));
    const handle = await startServices(store, () => () => {});
    assert.ok(handle);
    return { store, handle: handle! };
  }

  it('startService creates ref child and starts service', async () => {
    const { store, handle } = await boot();

    await store.set({ $path: '/srv/a', $type: 'test.autosvc' } as NodeData);
    await startService('/srv/a');

    assert.deepEqual(svcLog, ['start:/srv/a']);

    const { items } = await store.getChildren('/sys/autostart');
    const ref = items.find(n => (n as any).$ref === '/srv/a');
    assert.ok(ref, 'ref child created');
    assert.equal(ref!.$type, 'ref');

    await handle.stop();
  });

  it('stopService stops service and removes ref', async () => {
    const { store, handle } = await boot();

    await store.set({ $path: '/srv/b', $type: 'test.autosvc' } as NodeData);
    await startService('/srv/b');
    await stopService('/srv/b');

    assert.deepEqual(svcLog, ['start:/srv/b', 'stop:/srv/b']);

    const { items } = await store.getChildren('/sys/autostart');
    const ref = items.find(n => (n as any).$ref === '/srv/b');
    assert.equal(ref, undefined, 'ref removed after stop');

    await handle.stop();
  });

  it('startService is idempotent', async () => {
    const { store, handle } = await boot();

    await store.set({ $path: '/srv/c', $type: 'test.autosvc' } as NodeData);
    await startService('/srv/c');
    await startService('/srv/c');

    assert.deepEqual(svcLog, ['start:/srv/c'], 'started only once');
    await handle.stop();
  });

  it('boot walks existing ref children', async () => {
    svcLog.length = 0;
    const store = createMemoryTree();
    await store.set(createNode('/sys/autostart', 'autostart'));
    await store.set({ $path: '/srv/d', $type: 'test.autosvc' } as NodeData);
    await store.set({ $path: '/sys/autostart/d', $type: 'ref', $ref: '/srv/d' } as NodeData);

    const handle = await startServices(store, () => () => {});
    assert.deepEqual(svcLog, ['start:/srv/d']);
    await handle!.stop();
  });
});
