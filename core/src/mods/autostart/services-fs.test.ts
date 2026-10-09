import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registerType } from '#comp';
import { register, unregister } from '#core/registry';
import { collectModule, registerKernel, type CollectedModule } from '#kernel/manifest';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { R, W, type Session, type Node } from '#kernel/types';
import { KernelError } from '#errors';

let autostartModule: Promise<CollectedModule> | undefined;

/** Collect the actual cached entry once and reuse its immutable module manifest. */
function collectAutostart(): Promise<CollectedModule> {
  return autostartModule ??= collectModule('@treenx/core/autostart', () => import('#mods/autostart/kernel'));
}

it('starts the registered discovery service on canonical filesystem reopen', { timeout: 10_000 }, async (t) => {
  const type = `startup-contract.worker-${randomUUID()}`;
  const starts: string[] = [];
  const discovered: number[] = [];
  const autostartSchema = JSON.parse(await readFile(new URL('./schemas/autostart.json', import.meta.url), 'utf8'));
  const module = await collectModule(`startup-contract:${randomUUID()}`, () => {
    class Worker {}
    registerType(type, Worker, { security: 'user-capability' });
    register(type, 'schema', () => ({ $id: type, type: 'object', properties: {} }));
    class Autostart {}
    registerType('autostart', Autostart, { security: 'user-capability' });
    register('autostart', 'schema', () => ({ ...autostartSchema, methods: {} }));
    registerKernel('autostart', 'service', async (node: Node, session: Session) => {
      starts.push(session.actor.principal);
      const delivery = (async () => { for await (const frame of session.lane) assert.notEqual(frame.t, 'fail'); })();
      const configured = await session.read({ children: node.$path });
      discovered.push(configured.list.length);
      return { async stop() { await delivery; } };
    });
    registerKernel(type, 'service', async (_node: Node, session: Session) => {
      const delivery = (async () => {
        for await (const frame of session.lane) assert.notEqual(frame.t, 'fail');
      })();
      void delivery.catch(error => { console.error(error); });
      return { async stop() { await delivery; } };
    });
  });
  const parent = fileURLToPath(new URL('../../../../../temp/native-service-functional/data/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const config = {
    id: `startup:${randomUUID()}`,
    directory: await mkdtemp(join(parent, 'instance-')),
    modules: [module],
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
  };
  let runtime = await openNativeRuntime(config);
  const deliveries: Promise<void>[] = [];
  t.after(async () => {
    await runtime.close();
    await Promise.all(deliveries);
    unregister(type, 'class');
    unregister(type, 'schema');
    unregister('autostart', 'class');
    unregister('autostart', 'schema');
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  deliveries.push(drainSession(admin));
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/services', $type: 't.dir' } },
    { op: 'put', node: { $path: '/services/worker', $type: type } },
    { op: 'put', node: { $path: '/sys/autostart', $type: 't.autostart' } },
  ] }).outcome;
  const copy = (await admin.read({ node: '/services/worker' })).copies[0];
  assert.ok('node' in copy);
  const recipient = copy.node;
  const ownerCopy = (await admin.read({ node: '/sys/autostart' })).copies[0];
  assert.ok('node' in ownerCopy);
  const owner = ownerCopy.node;
  await admin.commit({ opId: key(), expect: { nodes: [{ path: recipient.$path, rev: recipient.$rev }, { path: owner.$path, rev: owner.$rev }] }, changes: [
    { op: 'patch', path: recipient.$path, ops: { $set: { $acl: [{ subject: { group: `n:${recipient.$id}` }, grant: R | W }, { subject: { group: `n:${owner.$id}` }, grant: R }] } } },
    { op: 'patch', path: owner.$path, ops: { $set: { $acl: [{ subject: { group: `n:${owner.$id}` }, grant: R }] } } },
    { op: 'put', node: { $path: '/sys/autostart/worker', $type: 't.ref', $ref: recipient.$path } },
  ] }).outcome;
  admin.close();
  await Promise.all(deliveries);
  await runtime.close();
  const before = starts.length;
  runtime = await openNativeRuntime(config);
  assert.equal(starts.length, before + 1);
  assert.equal(starts.at(-1), `n:${owner.$id}`);
  assert.equal(discovered.at(-1), 1);
});

it('starts a canonical bound child service on filesystem reopen', { timeout: 10_000 }, async (t) => {
  const type = `startup-contract.worker-${randomUUID()}`;
  const starts: string[] = [];
  const autostart = await collectAutostart();
  const module = await collectModule(`startup-contract:${randomUUID()}`, () => {
    class Worker {}
    registerType(type, Worker, { security: 'user-capability' });
    register(type, 'schema', () => ({ $id: type, type: 'object', properties: {} }));
    registerKernel(type, 'service', async (_node: Node, session: Session) => {
      starts.push(session.actor.principal);
      const delivery = (async () => {
        for await (const frame of session.lane) assert.notEqual(frame.t, 'fail');
      })();
      void delivery.catch(error => { console.error(error); });
      return { done: delivery, async stop() { await delivery; } };
    });
  });
  const parent = fileURLToPath(new URL('../../../../../temp/native-service-functional/data/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const config = {
    id: `startup:${randomUUID()}`,
    directory: await mkdtemp(join(parent, 'instance-')),
    modules: [autostart, module],
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
  };
  let runtime = await openNativeRuntime(config);
  const deliveries: Promise<void>[] = [];
  t.after(async () => {
    await runtime.close();
    await Promise.all(deliveries);
    unregister(type, 'class');
    unregister(type, 'schema');
    unregister('autostart', 'class');
    unregister('autostart', 'schema');
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  deliveries.push(drainSession(admin));
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/services', $type: 't.dir' } },
    { op: 'put', node: { $path: '/services/worker', $type: type } },
    { op: 'put', node: { $path: '/sys/autostart', $type: 't.autostart' } },
  ] }).outcome;
  const copy = (await admin.read({ node: '/services/worker' })).copies[0];
  assert.ok('node' in copy);
  const recipient = copy.node;
  const ownerCopy = (await admin.read({ node: '/sys/autostart' })).copies[0];
  assert.ok('node' in ownerCopy);
  const owner = ownerCopy.node;
  await admin.commit({ opId: key(), expect: { nodes: [{ path: recipient.$path, rev: recipient.$rev }, { path: owner.$path, rev: owner.$rev }] }, changes: [
    { op: 'patch', path: recipient.$path, ops: { $set: { $acl: [{ subject: { group: `n:${recipient.$id}` }, grant: R | W }, { subject: { group: `n:${owner.$id}` }, grant: R }] } } },
    { op: 'patch', path: owner.$path, ops: { $set: { $acl: [{ subject: { group: `n:${owner.$id}` }, grant: R }] } } },
    { op: 'put', node: { $path: '/sys/autostart/worker', $type: 't.ref', $ref: recipient.$path } },
    { op: 'put', node: { $path: '/sys/autostart/alias', $type: 't.ref', $ref: recipient.$path } },
  ] }).outcome;
  admin.close();
  await Promise.all(deliveries);
  await runtime.close();
  const before = starts.length;
  runtime = await openNativeRuntime(config);
  assert.equal(starts.length, before + 1);
  assert.equal(starts.at(-1), `n:${recipient.$id}`);
});

/** A changed accepted ref ends the old real admission before its paused handler can return. */
async function assertPausedDeclarationChange(t: TestContext, retarget: boolean): Promise<void> {
  const type = `startup-contract.worker-${randomUUID()}`;
  let reached = () => {};
  let finish = () => {};
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  let stopped = () => {};
  const stoppedOnce = new Promise<void>(resolve => { stopped = resolve; });
  let stops = 0;
  let owned: Session | undefined;
  const starts: string[] = [];
  let replaced = () => {};
  const replacementEntered = new Promise<void>(resolve => { replaced = resolve; });
  const autostart = await collectAutostart();
  const module = await collectModule(`startup-contract:${randomUUID()}`, () => {
    class Worker {}
    registerType(type, Worker, { security: 'user-capability' });
    register(type, 'schema', () => ({ $id: type, type: 'object', properties: {} }));
    registerKernel(type, 'service', async (_node: Node, session: Session) => {
      starts.push(session.actor.principal);
      owned = session;
      if (starts.length === 1) reached();
      else replaced();
      await release;
      const delivery = (async () => {
        for await (const frame of session.lane) assert.notEqual(frame.t, 'fail');
      })();
      void delivery.catch(error => { console.error(error); });
      return { done: delivery, async stop() { stops++; try { await delivery; } finally { stopped(); } } };
    });
  });
  const parent = fileURLToPath(new URL('../../../../../temp/native-service-functional/data/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const config = {
    id: `startup:${randomUUID()}`,
    directory: await mkdtemp(join(parent, 'instance-')),
    modules: [autostart, module],
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
  };
  let runtime = await openNativeRuntime(config);
  const deliveries: Promise<void>[] = [];
  t.after(async () => {
    finish();
    await runtime.close();
    await Promise.all(deliveries);
    unregister(type, 'class');
    unregister(type, 'schema');
    unregister('autostart', 'class');
    unregister('autostart', 'schema');
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  deliveries.push(drainSession(admin));
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/services', $type: 't.dir' } },
    { op: 'put', node: { $path: '/services/worker', $type: type } },
    { op: 'put', node: { $path: '/services/next', $type: type } },
    { op: 'put', node: { $path: '/sys/autostart', $type: 't.autostart' } },
  ] }).outcome;
  const copy = (await admin.read({ node: '/services/worker' })).copies[0];
  assert.ok('node' in copy);
  const recipient = copy.node;
  const nextCopy = (await admin.read({ node: '/services/next' })).copies[0];
  assert.ok('node' in nextCopy);
  const next = nextCopy.node;
  const ownerCopy = (await admin.read({ node: '/sys/autostart' })).copies[0];
  assert.ok('node' in ownerCopy);
  const owner = ownerCopy.node;
  await admin.commit({ opId: key(), expect: { nodes: [{ path: recipient.$path, rev: recipient.$rev }, { path: owner.$path, rev: owner.$rev }, { path: next.$path, rev: next.$rev }] }, changes: [
    { op: 'patch', path: recipient.$path, ops: { $set: { $acl: [{ subject: { group: `n:${recipient.$id}` }, grant: R | W }, { subject: { group: `n:${owner.$id}` }, grant: R }] } } },
    { op: 'patch', path: next.$path, ops: { $set: { $acl: [{ subject: { group: `n:${next.$id}` }, grant: R | W }, { subject: { group: `n:${owner.$id}` }, grant: R }] } } },
    { op: 'patch', path: owner.$path, ops: { $set: { $acl: [{ subject: { group: `n:${owner.$id}` }, grant: R }] } } },
    { op: 'put', node: { $path: '/sys/autostart/worker', $type: 't.ref', $ref: recipient.$path } },
  ] }).outcome;
  await entered;
  const ended = owned;
  assert.ok(ended);
  await admin.commit({ opId: key(), changes: retarget
    ? [{ op: 'patch', path: '/sys/autostart/worker', ops: { $set: { $ref: next.$path } } }]
    : [{ op: 'remove', path: '/sys/autostart/worker' }] }).outcome;
  await admin.read({ node: '/sys/autostart' });
  await assert.rejects(async () => ended.read({ node: recipient.$path }), error => error instanceof KernelError && error.code === 'CANCELLED');
  if (retarget) await replacementEntered;
  assert.deepEqual(starts, retarget ? [`n:${recipient.$id}`, `n:${next.$id}`] : [`n:${recipient.$id}`]);
  finish();
  await stoppedOnce;
  if (retarget) await admin.commit({ opId: key(), changes: [] }).outcome;
  assert.equal(stops, 1);
  assert.equal(starts.length, retarget ? 2 : 1);
}

it('revokes a paused child on accepted ref removal and releases its late run once', { timeout: 10_000 }, async t => {
  await assertPausedDeclarationChange(t, false);
});

it('revokes a paused child before starting an accepted ref replacement', { timeout: 10_000 }, async t => {
  await assertPausedDeclarationChange(t, true);
});
