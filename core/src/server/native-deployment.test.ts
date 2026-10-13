import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openTwpHttp } from '#client/http-twp';
import { createTwpClient } from '#client/twp';
import { R, W, A, type Credential, type ModuleManifest, type Pending } from '#kernel/types';
import { KernelError } from '#errors';
import { prepareCredential } from '#kernel/auth/credentials';
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

test('full caller-visible type catalog fits default read limits across 306 module types', async () => {
  const temporary = new URL('../../../../temp/native-catalog-batch/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('dataset-', temporary)));
  const names = Array.from({ length: 306 }, (_, index) => `catalog.fixture${String(index).padStart(3, '0')}`);
  const manifest: ModuleManifest = { id: 'catalog.fixture', open: [], security: [],
    types: names.map(name => ({ name, module: 'catalog.fixture', security: 'ordinary', version: 0,
      schema: { type: 'object', properties: {} }, actions: {} })) };
  const entry = join(directory, 'inventory.mjs');
  await writeFile(entry, `export default () => ({ manifest: ${JSON.stringify(manifest)} });\n`);
  const runtime = await openNativeDeployment({
    runtime: { id: randomUUID(), directory: join(directory, 'root'), credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: 'fixture-password' } },
    modules: [
      { id: 'platform', entry: new URL('../mods/platform/kernel.ts', import.meta.url).href },
      { id: 'catalog.fixture', entry: pathToFileURL(entry).href },
    ],
  });
  assert.equal(runtime.instance.limits().readNodes, 1000);
  const admin = await http(runtime, runtime.instance.setupCredential);
  try {
    await finish(admin.client.commit({ changes: [{ op: 'put', node: { $path: '/catalog', $type: 't.system' } }] }));
    const catalog = (await admin.client.act({ path: '/catalog', action: 'catalog', args: {} }).outcome).value;
    assert.ok(Array.isArray(catalog));
    assert.deepEqual(catalog.map(description => description.name).filter(name => name.startsWith('catalog.fixture')), names);
    const root = (await admin.client.read({ node: '/' })).copies[0];
    assert.ok('node' in root);
    await finish(admin.client.commit({ changes: [
      { op: 'patch', path: '/', ops: { $set: { $acl: [...root.node.$acl ?? [], { subject: { group: 'authenticated' }, grant: R }] } } },
      { op: 'patch', path: `/sys/types/${names[1]}`, ops: { $set: { $acl: [{ subject: { group: 'authenticated' }, deny: R | W | A }] } } },
      { op: 'put', node: { $path: '/auth/users/reader', $type: 't.user', name: 'reader', status: 'active',
        '#groups': { $type: 't.groups', list: [] } } },
    ] }));
    const account = (await admin.client.read({ node: '/auth/users/reader' })).copies[0];
    assert.ok('node' in account);
    const issued = prepareCredential(account.node.$id, { expiresAt: Date.now() + 60_000 });
    await finish(admin.client.commit({ changes: [{ op: 'put', node: issued.node }] }));
    const reader = await http(runtime, issued.credential);
    try {
      await assert.rejects(reader.client.act({ path: '/catalog', action: 'describe_type', args: { type: names[1] } }).outcome,
      error => error instanceof KernelError && error.code === 'NOT_FOUND');
      const visible = (await reader.client.act({ path: '/catalog', action: 'catalog', args: {} }).outcome).value;
      assert.ok(Array.isArray(visible));
      assert.equal(visible.some(description => description.name === names[1]), false);
      assert.equal(visible.some(description => description.name === names[0]), true);
    } finally { await reader.close(); }
  } finally { await admin.close(); await runtime.close(); }
});

test('fresh seeded service first mutation follows accepted mount preparation', async () => {
  const temporary = new URL('../../../../temp/native-seeded-service/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('dataset-', temporary)));
  await mkdir(join(directory, 'documents'));
  const runtime = await openNativeDeployment({
    runtime: { id: randomUUID(), directory: join(directory, 'root'), credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: 'fixture-password' },
      mountDirectories: { documents: join(directory, 'documents') } },
    modules: [{ id: 'boot-fixture', entry: new URL('./native-deployment-fixture.ts', import.meta.url).href }],
    additionalModules: [{ id: '@treenx/mods/prefab', entry: new URL('../../../mods/prefab/kernel.ts', import.meta.url).href }],
    seeds: { sources: [
      { $path: '/sys/mods', $type: 't.dir' },
      { $path: '/sys/mods/boot', $type: 't.dir' },
      { $path: '/sys/mods/boot/prefabs', $type: 't.dir' },
    ], prefabs: [{ target: '/', source: {
      $path: '/sys/mods/boot/prefabs/seed', $type: 't.prefab', mod: 'boot', name: 'seed',
      nodes: [
        { $path: 'sys/autostart', $type: 'boot.worker' },
        { $path: 'sys/autostart/state', $type: 'boot.state', label: '' },
        { $path: 'documents', $type: 't.mount-point',
          '#groups': { $type: 't.groups', list: ['admins'] },
          '#mount': { $type: 't.mount.rawfs', directory: 'documents', pattern: '', external: 'none' } },
      ], grants: [{ executor: 'sys/autostart', target: 'sys/autostart', grant: R | W }],
    } }] },
  });
  const connection = await http(runtime, runtime.instance.setupCredential);
  try {
    const state = (await connection.client.read({ node: '/sys/autostart/state' })).copies[0];
    assert.ok('node' in state);
    assert.equal(state.node.label, 'ecivres');
  } finally { await connection.close(); await runtime.close(); }
});

test('fresh seeded filesystem mounts preserve the public HTTP key for the first action', async () => {
  const temporary = new URL('../../../../temp/native-seeded-intake/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('dataset-', temporary)));
  await mkdir(join(directory, 'documents'));
  const runtime = await openNativeDeployment({
    runtime: { id: randomUUID(), directory: join(directory, 'root'), credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: 'fixture-password' },
      mountDirectories: { documents: join(directory, 'documents') } },
    modules: [{ id: 'boot-fixture', entry: new URL('./native-deployment-fixture.ts', import.meta.url).href }],
    additionalModules: [{ id: '@treenx/mods/prefab', entry: new URL('../../../mods/prefab/kernel.ts', import.meta.url).href }],
    seeds: { sources: [
      { $path: '/sys/mods', $type: 't.dir' },
      { $path: '/sys/mods/boot', $type: 't.dir' },
      { $path: '/sys/mods/boot/prefabs', $type: 't.dir' },
    ], prefabs: [{ target: '/', source: {
      $path: '/sys/mods/boot/prefabs/seed', $type: 't.prefab', mod: 'boot', name: 'seed',
      nodes: [
        { $path: 'worker', $type: 'boot.worker' },
        { $path: 'worker/state', $type: 'boot.state', label: '' },
        { $path: 'documents', $type: 't.mount-point',
          '#groups': { $type: 't.groups', list: ['admins'] },
          '#mount': { $type: 't.mount.rawfs', directory: 'documents', pattern: '', external: 'none' } },
      ],
    } }] },
  });
  const connection = await http(runtime, runtime.instance.setupCredential);
  try {
    const before = (await connection.client.read({ node: '/worker/state' })).copies[0];
    assert.ok('node' in before);
    assert.equal(before.node.label, '');
    assert.equal((await finish(connection.client.act({ path: '/worker', action: 'reverse', args: 'first',
      opId: connection.client.key() }))).value, 'tsrif');
    const after = (await connection.client.read({ node: '/worker/state' })).copies[0];
    assert.ok('node' in after);
    assert.equal(after.node.label, 'tsrif');
  } finally { await connection.close(); await runtime.close(); }
});

test('native deployment cold boots accepted seeds, HTTP actions and an owned service, then reopens unchanged seeds', async () => {
  const temporary = new URL('../../../../temp/native-boot/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('dataset-', temporary)));
  const config: NativeDeploymentConfig = {
    runtime: { id: 'native-boot', directory, credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: 'native-boot-password' } },
    modules: [
      { id: 'boot-fixture', entry: new URL('./native-deployment-fixture.ts', import.meta.url).href },
    ],
    additionalModules: [
      { id: '@treenx/mods/prefab', entry: new URL('../../../mods/prefab/kernel.ts', import.meta.url).href },
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


/** Repeated compiled imports must bind each actual service to its own deployment HTTP lifetime. */
test('native module factories bind independent MCP route owners', async () => {
  const modules = [
    { id: 'mcp-deployment', entry: new URL('../../../mods/mcp/kernel.ts', import.meta.url).href },
    { id: 'mcp-system', entry: new URL('./native-http-module-fixture.ts', import.meta.url).href },
  ];
  async function deployment() {
    const directory = await mkdtemp(resolve('temp/native-mcp-deployment-'));
    const runtime = await openNativeDeployment({ runtime: { id: randomUUID(), directory, credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: 'mcp-deployment-password' } }, modules });
    const credential = runtime.instance.setupCredential;
    assert.ok(credential);
    const session = await runtime.instance.openSession(credential);
    const delivery = (async () => { for await (const _frame of session.lane) {} })();
    const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
    let registeredResolve = () => {};
    const registered = new Promise<void>(resolve => { registeredResolve = resolve; });
    const register = runtime.httpRoutes.register;
    runtime.httpRoutes.register = (path, handler) => {
      const retire = register(path, handler);
      registeredResolve();
      return retire;
    };
    try {
      await session.commit({ opId: key(), changes: [
        { op: 'put', node: { $path: '/sys/mcp', $type: 't.dir' } },
        { op: 'put', node: { $path: '/sys/mcp/catalog', $type: 't.system' } },
        { op: 'put', node: { $path: '/data', $type: 't.dir' } },
        { op: 'put', node: { $path: '/mcp-service', $type: 'mcp.server', url: '/mcp', systemPath: '/sys/mcp/catalog' } },
      ] }).outcome;
      const copy = (await session.read({ node: '/mcp-service' })).copies[0];
      if ('error' in copy) throw copy.error;
      await session.commit({ opId: key(), expect: { nodes: [{ path: copy.node.$path, rev: copy.node.$rev }] }, changes: [
        { op: 'patch', path: copy.node.$path, ops: { $set: { $acl: [{ subject: { group: `n:${copy.node.$id}` }, grant: R }] } } },
      ] }).outcome;
      await session.commit({ opId: key(), changes: [{ op: 'move', from: copy.node.$path, to: '/sys/autostart' }] }).outcome;
      await registered;
    } finally { session.close(); await delivery; }
    const binding = createTwpHttpServer({ instance: runtime.instance, routes: runtime.httpRoutes, allowedOrigins: [], credentialTtlMs: 60_000 });
    binding.server.listen(0, '127.0.0.1');
    await once(binding.server, 'listening');
    const address = binding.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing HTTP address');
    const client = new Client({ name: 'deployment-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${credential.token}` } } }));
    return { runtime, client, async close() { await client.close(); await binding.close(); await runtime.close(); } };
  }
  const first = await deployment();
  let firstClosed = false;
  try {
    const second = await deployment();
    try {
      assert.notEqual(first.runtime.httpRoutes, second.runtime.httpRoutes);
      assert.equal((await first.client.callTool({ name: 'get_node', arguments: { path: '/data' } })).isError, undefined);
      assert.equal((await second.client.callTool({ name: 'get_node', arguments: { path: '/data' } })).isError, undefined);
      await first.close(); firstClosed = true;
      assert.equal((await second.client.callTool({ name: 'get_node', arguments: { path: '/data' } })).isError, undefined);
      assert.equal((await second.client.callTool({ name: 'catalog', arguments: {} })).isError, undefined);
    } finally { await second.close(); }
  } finally { if (!firstClosed) await first.close(); }
});
