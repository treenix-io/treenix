import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openTwpHttp } from '#client/http-twp';
import { createTwpClient } from '#client/twp';
import { R, W, type Credential, type Pending } from '#kernel/types';
import { createTwpHttpServer } from '#server/http-twp';
import { openNativeDeployment, type NativeDeploymentConfig } from './native-deployment';

/** Drain streaming pieces while the native HTTP client owns lane delivery. */
async function finish(pending: Pending) {
  for await (const _chunk of pending.chunks) {}
  return pending.outcome;
}

/** Start the genuine HTTP binding over the deployment's actual native session factory. */
async function http(runtime: Awaited<ReturnType<typeof openNativeDeployment>>, credential?: Credential) {
  const binding = createTwpHttpServer({ instance: runtime.instance, allowedOrigins: [], credentialTtlMs: 60_000 });
  binding.server.listen(0, '127.0.0.1');
  await once(binding.server, 'listening');
  const address = binding.server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const transport = await openTwpHttp({ url: `http://127.0.0.1:${address.port}`, credential });
  const client = createTwpClient(transport, { credential, close: () => transport.close() });
  const welcome = await client.ready;
  return { client, welcome, async close() { client.close(); await binding.close(); } };
}

test('native deployment cold boots accepted seeds, HTTP actions and an owned service, then reopens unchanged seeds', async () => {
  const temporary = new URL('../../../../temp/native-boot/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('dataset-', temporary)));
  const config: NativeDeploymentConfig = {
    runtime: { id: 'native-boot', directory, credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: 'native-boot-password' } },
    modules: [
      { id: 'boot-fixture', entry: new URL('./native-deployment-fixture.ts', import.meta.url).href },
      { id: 'boot-prefab', entry: new URL('./native-deployment-prefab-fixture.ts', import.meta.url).href },
    ],
    seeds: { sources: [
      { $path: '/sys/mods', $type: 't.dir' },
      { $path: '/sys/mods/boot', $type: 't.dir' },
      { $path: '/sys/mods/boot/prefabs', $type: 't.dir' },
    ], prefabs: [{ target: '/worker', source: {
      $path: '/sys/mods/boot/prefabs/seed', $type: 't.prefab', mod: 'boot', name: 'seed',
      nodes: [{ $path: '.', $type: 'boot.worker' }, { $path: 'state', $type: 'boot.state', label: '' }],
    } }] },
  };
  const runtime = await openNativeDeployment(config);
  assert.ok(runtime.instance.setupCredential);
  const credential = runtime.instance.setupCredential;
  const first = await http(runtime, credential);
  let identity = '';
  try {
    const selected = (await first.client.read({ node: '/worker' })).copies[0];
    if ('error' in selected) throw selected.error;
    identity = selected.node.$id;
    const initial = (await first.client.read({ node: '/worker/state' })).copies[0];
    if ('error' in initial) throw initial.error;
    assert.equal(initial.node.label, '');
    assert.equal((await finish(first.client.act({ path: '/worker', action: 'reverse', args: 'action' }))).value, 'noitca');
    const executor = (await first.client.read({ node: '/worker' })).copies[0];
    if ('error' in executor) throw executor.error;
    await finish(first.client.commit({ expect: { nodes: [{ path: '/worker', rev: executor.node.$rev }] }, changes: [{ op: 'patch', path: '/worker', ops: { $set: {
      $acl: [{ subject: { group: `n:${identity}` }, grant: R | W }],
    } } }] }));
    await finish(first.client.commit({ changes: [{ op: 'move', from: '/worker', to: '/sys/autostart' }] }));
    const completed = new Promise<void>((resolve, reject) => {
      const subscription = first.client.sub({ node: '/sys/autostart/state' }, () => {
        const copy = first.client.cache.at('/sys/autostart/state');
        if (copy === undefined) return;
        if ('error' in copy) { reject(copy.error); return; }
        if (copy.node.label === 'ecivres') resolve();
      }, reject);
      subscription.ready.catch(reject);
    });
    await completed;
    const service = (await first.client.read({ node: '/sys/autostart' })).copies[0];
    if ('error' in service) throw service.error;
    assert.equal(service.node.$id, identity);
    const state = (await first.client.read({ node: '/sys/autostart/state' })).copies[0];
    if ('error' in state) throw state.error;
    assert.equal(state.node.label, 'ecivres');
    await finish(first.client.commit({ changes: [{ op: 'move', from: '/sys/autostart', to: '/worker' }] }));
  } finally { await first.close(); await runtime.close(); }
  const reopened = await openNativeDeployment({ ...config, runtime: { ...config.runtime, installerCredential: credential } });
  const second = await http(reopened, credential);
  try {
    assert.notEqual(second.welcome.intake, first.welcome.intake);
    const selected = (await second.client.read({ node: '/worker' })).copies[0];
    if ('error' in selected) throw selected.error;
    assert.equal(selected.node.$id, identity);
    const state = (await second.client.read({ node: '/worker/state' })).copies[0];
    if ('error' in state) throw state.error;
    assert.equal(state.node.label, 'ecivres');
  } finally { await second.close(); await reopened.close(); }
});
