// Autostart dynamic start/stop tests
// Tests: startService creates ref + starts, stopService removes ref + stops, boot walks children

import { startServices } from '#contexts/service/index';
import type { NodeData } from '#core';
import { A, createNode, R, register, W } from '#core';
import { KernelError } from '#errors';
import { withAcl } from '#security/acl-tree';
import { createMemoryTree } from '#tree';
import { withExecute } from '#server/actions';
import { loadSchemasFromDir } from '#schema/load';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Import real autostart module — registers 'autostart' type + service handler
import { startService, stopService } from './service';

loadSchemasFromDir(join(dirname(fileURLToPath(import.meta.url)), 'schemas'));

// Register test service types once (sealed registry)
const svcLog: string[] = [];
register('test.autosvc', 'service', async (node) => {
  svcLog.push(`start:${node.$path}`);
  return { stop: async () => { svcLog.push(`stop:${node.$path}`); } };
});

describe('autostart dynamic start/stop', () => {
  async function boot() {
    svcLog.length = 0;
    const tree = createMemoryTree();
    await tree.set(createNode('/sys/autostart', 'autostart'));
    const handle = await startServices(withExecute(tree), () => () => {});
    assert.ok(handle);
    return { tree, handle: handle! };
  }

  it('startService creates ref child and starts service', async () => {
    const { tree, handle } = await boot();

    await tree.set({ $path: '/srv/a', $type: 'test.autosvc' } as NodeData);
    await startService('/srv/a');

    assert.deepEqual(svcLog, ['start:/srv/a']);

    const { items } = await tree.getChildren('/sys/autostart');
    const ref = items.find(n => (n as any).$ref === '/srv/a');
    assert.ok(ref, 'ref child created');
    assert.equal(ref!.$type, 'ref');

    await handle.stop();
  });

  it('failed start leaves no orphan ref (tree = truth)', async () => {
    const { tree, handle } = await boot();

    // node exists but its $type has no 'service' handler → _startService throws
    await tree.set({ $path: '/srv/fail', $type: 'test.noservice' } as NodeData);
    await assert.rejects(() => startService('/srv/fail'));

    const { items } = await tree.getChildren('/sys/autostart');
    const ref = items.find(n => (n as any).$ref === '/srv/fail');
    assert.equal(ref, undefined, 'no ref written when start fails');

    await handle.stop();
  });

  it('stopService stops service and removes ref', async () => {
    const { tree, handle } = await boot();

    await tree.set({ $path: '/srv/b', $type: 'test.autosvc' } as NodeData);
    await startService('/srv/b');
    await stopService('/srv/b');

    assert.deepEqual(svcLog, ['start:/srv/b', 'stop:/srv/b']);

    const { items } = await tree.getChildren('/sys/autostart');
    const ref = items.find(n => (n as any).$ref === '/srv/b');
    assert.equal(ref, undefined, 'ref removed after stop');

    await handle.stop();
  });

  it('startService is idempotent', async () => {
    const { tree, handle } = await boot();

    await tree.set({ $path: '/srv/c', $type: 'test.autosvc' } as NodeData);
    await startService('/srv/c');
    await startService('/srv/c');

    assert.deepEqual(svcLog, ['start:/srv/c'], 'started only once');
    await handle.stop();
  });

  // Services run on the supervisor's system tree; the actions need only R on
  // /sys/autostart. The caller must hold W on the registry or nothing runs.
  it('start/stop actions are refused for a caller without W on the registry', async () => {
    const { tree, handle } = await boot();
    await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }, { g: 'admins', p: R | W | A }] });
    await tree.set({ $path: '/srv/e', $type: 'test.autosvc' } as NodeData);
    const as = (userId: string, claims: string[]) =>
      withExecute(withAcl(tree, userId, claims), { identity: { userId, claims } });
    const forbidden = (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN';

    await assert.rejects(() => as('anon:x', ['public']).execute('/sys/autostart', 'start', { path: '/srv/e' }), forbidden);
    assert.deepEqual(svcLog, [], 'nothing started');
    assert.equal((await tree.getChildren('/sys/autostart')).items.length, 0, 'no ref planted');

    await as('root', ['u:root', 'admins']).execute('/sys/autostart', 'start', { path: '/srv/e' });
    assert.deepEqual(svcLog, ['start:/srv/e']);
    await assert.rejects(() => as('anon:x', ['public']).execute('/sys/autostart', 'stop', { path: '/srv/e' }), forbidden);
    assert.deepEqual(svcLog, ['start:/srv/e'], 'still running');

    await handle.stop();
  });

  it('boot walks existing ref children', async () => {
    svcLog.length = 0;
    const tree = createMemoryTree();
    await tree.set(createNode('/sys/autostart', 'autostart'));
    await tree.set({ $path: '/srv/d', $type: 'test.autosvc' } as NodeData);
    await tree.set({ $path: '/sys/autostart/d', $type: 'ref', $ref: '/srv/d' } as NodeData);

    const handle = await startServices(withExecute(tree), () => () => {});
    assert.deepEqual(svcLog, ['start:/srv/d']);
    await handle!.stop();
  });
});
