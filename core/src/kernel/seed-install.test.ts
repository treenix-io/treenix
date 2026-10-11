import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it, type TestContext } from 'node:test';
import { getComponent } from '#core';
import { KernelError } from '#errors';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { installNativeSeeds, type NativeSeedPlan } from '#kernel/seed-install';
import type { CommitRequest, ModuleManifest, OpId, Session } from '#kernel/types';
import { nativePrefabManifest, type NativePrefabSource } from '#mod/native-prefab';

const module: ModuleManifest = { id: 'seed-fixture', security: [], open: [], types: [
  { name: 'seed.fixture', module: 'seed-fixture', security: 'ordinary', version: 0,
    schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }, actions: {} },
] };

async function fixture(t: TestContext) {
  const fixtures = resolve(import.meta.dirname, '../../../../temp/native-seed-fixtures');
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(resolve(fixtures, 'dataset-'));
  const config = { id: randomUUID(), directory, rootExternal: 'none' as const,
    credentialTtlMs: 60_000, firstAdmin: { path: '/admin', name: 'admin', password: 'seed-fixture-password' },
    modules: [module, await nativePrefabManifest()] };
  const runtime = await openNativeRuntime(config);
  assert.ok(runtime.instance.setupCredential);
  const credential = runtime.instance.setupCredential;
  const session = await runtime.instance.openSession(credential);
  const delivery = drainSession(session);
  t.after(async () => { session.close(); await delivery; await runtime.close(); });
  const requests: CommitRequest[] = [];
  const commit = session.commit.bind(session);
  t.mock.method(session, 'commit', (request: CommitRequest) => { requests.push(request); return commit(request); });
  const key = (): OpId => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  return { session, requests, key, runtime, config, credential, delivery };
}

async function read(session: Session, path: string) {
  const copy = (await session.read({ node: path })).copies[0];
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

function plan(opId: OpId, target = '/seed'): NativeSeedPlan {
  return { opId, sources: [
    { $path: '/sys/mods', $type: 't.dir' },
    { $path: '/sys/mods/demo', $type: 't.dir' },
    { $path: '/sys/mods/demo/prefabs', $type: 't.dir' },
  ], prefabs: [{ target, allowAbsolute: true, source: {
    $path: '/sys/mods/demo/prefabs/seed', $type: 't.prefab', mod: 'demo', name: 'seed', nodes: [
      { $path: '.', $type: 'seed.fixture', value: 1, $id: 'captured-id', $rev: 'captured-rev', $refId: 'captured-ref' },
      { $path: 'child', $type: 'seed.fixture', value: 2 },
      { $path: '/absolute', $type: 'seed.fixture', value: 3 },
    ],
  } }] };
}

it('installs accepted prefab data through bounded requests and preserves it on repeat', { timeout: 10_000 }, async t => {
  const f = await fixture(t), first = plan(f.key());
  const installed = await installNativeSeeds(f.session, first);
  assert.ok(installed.installed.includes('/seed/child'));
  assert.equal((await read(f.session, '/seed')).value, 1);
  assert.equal((await read(f.session, '/absolute')).value, 3);
  assert.notEqual((await read(f.session, '/seed')).$id, 'captured-id');
  const source = await read(f.session, first.prefabs[0].source.$path);
  const prefab = getComponent<NativePrefabSource>(source, 't.prefab');
  assert.ok(prefab);
  for (const node of prefab.nodes) {
    assert.equal(node.$id, undefined); assert.equal(node.$rev, undefined); assert.equal(node.$refId, undefined);
  }
  assert.ok(f.requests.every(request => request.changes.length === 1));
  const before = f.requests.length;
  assert.deepEqual((await installNativeSeeds(f.session, { ...first, opId: f.key() })).installed, []);
  assert.equal(f.requests.length, before);
  assert.deepEqual(await read(f.session, source.$path), source);

  await f.session.commit({ opId: f.key(), changes: [{ op: 'remove', path: '/seed/child' }] }).outcome;
  const changedInput: NativeSeedPlan = { ...first, opId: f.key(), prefabs: first.prefabs.map(prefab => ({ ...prefab,
    source: { ...prefab.source, nodes: prefab.source.nodes.map(node => ({ ...node, value: 99 })) },
  })) };
  await installNativeSeeds(f.session, changedInput);
  assert.equal((await read(f.session, '/seed/child')).value, 2);
  assert.equal((await read(f.session, '/seed')).value, 1);
  assert.deepEqual(await read(f.session, source.$path), source);
});

it('refuses a replayed installation whose target was subsequently deleted', { timeout: 10_000 }, async t => {
  const f = await fixture(t), input = plan(f.key(), '/victim');
  await installNativeSeeds(f.session, input);
  const request = f.requests.find(request => request.changes.some(change => change.op === 'put' && change.node.$path === '/victim'));
  assert.ok(request);
  const replay = await f.session.commit(request).outcome;
  assert.ok(replay.pos);
  await f.session.commit({ opId: f.key(), changes: [
    { op: 'remove', path: '/victim/child' }, { op: 'remove', path: '/victim' },
  ] }).outcome;
  await assert.rejects(installNativeSeeds(f.session, input), error => error instanceof KernelError && error.code === 'CONFLICT');
  await assert.rejects(read(f.session, '/victim'), error => error instanceof KernelError && error.code === 'NOT_FOUND');
});

it('rejects retiring setup before publishing any source', { timeout: 10_000 }, async t => {
  const f = await fixture(t), input = plan(f.key());
  await assert.rejects(installNativeSeeds(f.session, { ...input,
    prefabs: input.prefabs.map(prefab => ({ ...prefab, setup: () => [] })),
  }), error => error instanceof KernelError && error.code === 'UNAVAILABLE');
  assert.equal(f.requests.length, 0);
  await assert.rejects(read(f.session, '/sys/mods/demo'), error => error instanceof KernelError && error.code === 'NOT_FOUND');
});

it('reuses the durable accepted source and preserves installed identities after reopening', { timeout: 10_000 }, async t => {
  const f = await fixture(t), input = plan(f.key());
  await installNativeSeeds(f.session, input);
  const source = await read(f.session, input.prefabs[0].source.$path);
  const target = await read(f.session, '/seed');
  f.session.close(); await f.delivery; await f.runtime.close();
  const reopened = await openNativeRuntime(f.config);
  const session = await reopened.instance.openSession(f.credential);
  const delivery = drainSession(session);
  try {
    const opId = { epoch: reopened.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() };
    assert.deepEqual((await installNativeSeeds(session, { ...input, opId })).installed, []);
    assert.deepEqual(await read(session, source.$path), source);
    assert.deepEqual(await read(session, '/seed'), target);
  } finally { session.close(); await delivery; await reopened.close(); }
});
