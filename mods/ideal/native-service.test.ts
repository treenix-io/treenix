import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNode } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { collectModule } from '@treenx/core/kernel';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { R, W, type Gate, type ModuleManifest, type Node, type Path, type Session } from '@treenx/core/kernel';
import { registerNativeIdeal } from './native';

let collected: Promise<readonly ModuleManifest[]> | undefined;

/** Collect the actual native entries without importing their legacy service implementations. */
function modules(): Promise<readonly ModuleManifest[]> {
  return collected ??= (async () => [
    await collectModule('@treenx/core/autostart', () => import('../../core/src/mods/autostart/kernel')),
    await collectModule('@treenx/mods/ideal', registerNativeIdeal),
  ])();
}

/** Drain the session's sole channel while observing accepted node changes. */
async function observeLane(session: Session, watch = true) {
  let intake = '';
  let readyResolve = () => {};
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const observers = new Map<Path, { accept(node: Node): boolean; resolve(node: Node): void }>();

  async function node(path: Path): Promise<Node> {
    const copy = (await session.read({ node: path })).copies[0];
    if ('error' in copy) throw copy.error;
    return copy.node;
  }

  async function inspect(): Promise<void> {
    for (const [path, observer] of observers) {
      const current = await node(path);
      if (observer.accept(current)) {
        observers.delete(path);
        observer.resolve(current);
      }
    }
  }

  const done = (async () => {
    for await (const frame of session.lane) {
      if (frame.t === 'welcome') { intake = frame.intake; readyResolve(); }
      if (frame.t === 'end') throw frame.error;
      if (frame.t === 'pos' && frame.coverage !== true) {
        if (frame.intake !== undefined) intake = frame.intake;
        await inspect();
      }
      if (frame.t === 'snap') await inspect();
    }
  })();
  await ready;
  if (watch) session.sub({ children: '/boards/ideas' });

  async function until(path: Path, accept: (node: Node) => boolean): Promise<Node> {
    const changed = new Promise<Node>(resolve => { observers.set(path, { accept, resolve }); });
    await inspect();
    return changed;
  }

  return { session, node, until, done, key: () => ({ epoch: intake, time: Date.now(), nonce: randomUUID() }) };
}

/** Authenticate the real admin and attach its only frame consumer. */
async function adminLane(runtime: Awaited<ReturnType<typeof openNativeRuntime>>) {
  const credential = runtime.instance.setupCredential ?? await runtime.instance.auth.login({
    account: '/admin', password: 'isolated-ideal-password',
  });
  return observeLane(await runtime.instance.openSession(credential));
}

/** Seed declared node grants through genuine admin commits before moving the bootstrap marker. */
async function fixture(t: TestContext, activate = true, gates: readonly Gate[] = []) {
  const parent = fileURLToPath(new URL('../../../temp/native-service-ideal/data/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const config = {
    id: `native-ideal:${randomUUID()}`,
    directory: await mkdtemp(join(parent, 'instance-')),
    modules: await modules(),
    gates,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'isolated-ideal-password' },
  };
  const runtime = await openNativeRuntime(config);
  const admin = await adminLane(runtime);
  let owned = true;

  /** Release the actual runtime once, preserving an expected close failure for its caller. */
  async function close(): Promise<void> {
    if (!owned) return;
    owned = false;
    try { await runtime.close(); } finally { await admin.done; }
  }
  t.after(close);

  const boardInput = createNode('/boards/ideas', 'ideal.board', { autoApproveThreshold: 5 });
  const first = createNode('/boards/ideas/first', 'ideal.idea', { title: 'First authored idea', votes: 0, status: 'new' });
  const second = createNode('/boards/ideas/second', 'ideal.idea', { title: 'Second authored idea', votes: 0, status: 'new' });
  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'put', node: { $path: '/boards', $type: 't.dir' } },
    { op: 'put', node: { $path: boardInput.$path, $type: boardInput.$type, autoApproveThreshold: 5 } },
    { op: 'put', node: { $path: first.$path, $type: first.$type, title: first.title, votes: 0, status: 'new', authored: { retained: true } } },
    { op: 'put', node: { $path: second.$path, $type: second.$type, title: second.title, votes: 0, status: 'new', authored: { retained: 'second' } } },
    { op: 'put', node: { $path: '/prepared-autostart', $type: 't.autostart' } },
  ] }).outcome;
  const board = await admin.node('/boards/ideas');
  const discovery = await admin.node('/prepared-autostart');
  await admin.session.commit({ opId: admin.key(), expect: { nodes: [
    { path: board.$path, rev: board.$rev }, { path: discovery.$path, rev: discovery.$rev },
  ] }, changes: [
    { op: 'patch', path: board.$path, ops: { $set: { $acl: [
      { subject: { group: `n:${board.$id}` }, grant: R | W },
      { subject: { group: `n:${discovery.$id}` }, grant: R },
    ] } } },
    { op: 'patch', path: discovery.$path, ops: { $set: { $acl: [{ subject: { group: `n:${discovery.$id}` }, grant: R }] } } },
    { op: 'put', node: { $path: '/prepared-autostart/boards-ideas', $type: 't.ref', $ref: board.$path, $refId: board.$id } },
  ] }).outcome;

  /** Publish the accepted bootstrap identity after its grants and reference are ready. */
  async function start(): Promise<void> {
    await admin.session.commit({ opId: admin.key(), changes: [
      { op: 'move', from: '/prepared-autostart', to: '/sys/autostart' },
    ] }).outcome;
    await runtime.instance.prepareServices();
  }
  if (activate) await start();
  return { runtime, admin, config, board, discovery, close, start };
}

it('approves successive eligible ideas through one real service lane while preserving authored fields', { timeout: 10_000 }, async t => {
  const { admin } = await fixture(t);
  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: '/boards/ideas/first', ops: { $set: { votes: 5 } } },
  ] }).outcome;
  const first = await admin.until('/boards/ideas/first', node => node.status === 'approved');
  assert.equal(first.title, 'First authored idea');
  assert.equal(first.votes, 5);
  assert.deepEqual(first.authored, { retained: true });

  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: '/boards/ideas/second', ops: { $set: { votes: 6 } } },
  ] }).outcome;
  const second = await admin.until('/boards/ideas/second', node => node.status === 'approved');
  assert.equal(second.title, 'Second authored idea');
  assert.equal(second.votes, 6);
  assert.deepEqual(second.authored, { retained: 'second' });
});

it('reopens the same Fs instance without approving an already accepted idea again', { timeout: 10_000 }, async t => {
  const { admin, config, close } = await fixture(t);
  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: '/boards/ideas/first', ops: { $set: { votes: 5 } } },
  ] }).outcome;
  const accepted = await admin.until('/boards/ideas/first', node => node.status === 'approved');
  const history = (await admin.session.read({ history: accepted.$path })).history;
  assert.ok(history !== undefined);
  await close();

  const reopened = await openNativeRuntime(config);
  const current = await adminLane(reopened);
  t.after(async () => { await reopened.close(); await current.done; });
  assert.deepEqual(await current.node(accepted.$path), accepted);
  assert.deepEqual((await current.session.read({ history: accepted.$path })).history, history);

  await current.session.commit({ opId: current.key(), changes: [
    { op: 'patch', path: '/boards/ideas/second', ops: { $set: { votes: 6 } } },
  ] }).outcome;
  const second = await current.until('/boards/ideas/second', node => node.status === 'approved');
  assert.equal(second.votes, 6);
  assert.deepEqual(second.authored, { retained: 'second' });
});

it('authorizes ordinary idea actions as their caller while retaining the service grant', { timeout: 10_000 }, async t => {
  const { runtime, admin, board, discovery } = await fixture(t);
  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: board.$path, ops: { $set: { $acl: [
      { subject: { group: `n:${board.$id}` }, grant: R | W },
      { subject: { group: `n:${discovery.$id}` }, grant: R },
      { subject: { group: 'public' }, grant: R },
    ] } } },
  ] }).outcome;
  const anonymousSession = await runtime.instance.openSession();
  const anonymous = await observeLane(anonymousSession);
  t.after(async () => { anonymousSession.close(); await anonymous.done; });
  const before = await admin.node('/boards/ideas/first');
  await assert.rejects(anonymous.session.act({ path: before.$path, action: 'upvote', args: {}, opId: anonymous.key() }).outcome,
    (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN');
  assert.deepEqual(await admin.node(before.$path), before);

  await admin.session.act({ path: before.$path, action: 'upvote', args: {}, opId: admin.key() }).outcome;
  const rejectKey = admin.key();
  await admin.session.act({ path: before.$path, action: 'reject', args: {}, opId: rejectKey }).outcome;
  const rejected = await admin.node(before.$path);
  assert.equal(rejected.votes, 1);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.authored, before.authored);
  const history = (await admin.session.read({ history: before.$path })).history;
  assert.ok(history !== undefined);
  const action = history.find(entry => entry.opId?.nonce === rejectKey.nonce);
  assert.ok(action !== undefined);
  assert.equal(action.executor, admin.session.actor.principal);
  assert.equal(action.caller, admin.session.actor.principal);
});

it('honors a removed service grant and a removed autostart reference after Fs reopen', { timeout: 10_000 }, async t => {
  const { admin, runtime, config, board, discovery, close } = await fixture(t);
  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: board.$path, ops: { $set: { $acl: [
      { subject: { group: `n:${discovery.$id}` }, grant: R },
    ] } } },
    { op: 'patch', path: '/boards/ideas/first', ops: { $set: { votes: 5 } } },
  ] }).outcome;
  await close();

  const reopened = await openNativeRuntime(config);
  const current = await adminLane(reopened);
  t.after(async () => { await reopened.close(); await current.done; });
  assert.equal((await current.node('/boards/ideas/first')).status, 'new');
  const nodeSession = await reopened.instance.openNodeSession(board.$path);
  const nodeLane = await observeLane(nodeSession, false);
  await assert.rejects(nodeLane.session.read({ node: '/boards/ideas/first' }),
    (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND');
  nodeSession.close();
  await nodeLane.done;

  await current.session.act({ path: '/sys/autostart', action: 'stop', args: { path: board.$path }, opId: current.key() }).outcome;
  await assert.rejects(current.session.read({ node: '/sys/autostart/boards-ideas' }),
    (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND');
  const recipient = await current.node(board.$path);
  await current.session.commit({ opId: current.key(), expect: { nodes: [
    { path: recipient.$path, rev: recipient.$rev },
  ] }, changes: [
    { op: 'patch', path: board.$path, ops: { $set: { $acl: [{ subject: { group: `n:${board.$id}` }, grant: R | W }] } } },
    { op: 'patch', path: '/boards/ideas/second', ops: { $set: { votes: 6 } } },
  ] }).outcome;
  await reopened.close();
  await current.done;

  const stopped = await openNativeRuntime(config);
  const inspected = await adminLane(stopped);
  t.after(async () => { await stopped.close(); await inspected.done; });
  assert.equal((await inspected.node('/boards/ideas/second')).status, 'new');
  assert.notEqual(runtime, stopped);
});

/** Accept only the precise write denial, including construction's aggregated cleanup errors. */
function writeDenied(error: unknown): boolean {
  if (error instanceof KernelError) return error.code === 'FORBIDDEN';
  return error instanceof AggregateError && error.errors.length > 0 && error.errors.every(writeDenied);
}

it('rejects cold Fs service startup without W and keeps the eligible idea unmodified', { timeout: 10_000 }, async t => {
  let principal = '';
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const gateEntered = new Promise<void>(resolve => { entered = resolve; });
  const gate: Gate = async (operation, actor) => {
    if (operation.kind === 'commit' && actor.principal === principal) {
      entered();
      await held;
    }
    return 'pass';
  };
  t.after(release);
  const { admin, config, board, discovery, start, close } = await fixture(t, false, [gate]);
  principal = `n:${board.$id}`;
  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: board.$path, ops: { $set: { $acl: [
      { subject: { group: `n:${board.$id}` }, grant: R },
      { subject: { group: `n:${discovery.$id}` }, grant: R },
    ] } } },
    { op: 'patch', path: '/boards/ideas/first', ops: { $set: { votes: 5 } } },
  ] }).outcome;
  const document = join(config.directory, 'boards', 'ideas', 'first', '$');
  const before = await readFile(document, 'utf8');
  const starting = start().then(() => ({ ended: false as const }), error => ({ ended: true as const, error }));
  await gateEntered;
  assert.equal((await admin.node('/boards/ideas/first')).status, 'new');
  await close();
  release();
  const started = await starting;
  if (started.ended) assert.ok(started.error instanceof KernelError && started.error.code === 'CANCELLED');
  const cold = await openNativeRuntime({ ...config, gates: [] }).then(
    opened => ({ opened }), error => ({ error }),
  );
  if ('opened' in cold) await assert.rejects(cold.opened.close(), writeDenied);
  assert.ok('error' in cold);
  assert.ok(writeDenied(cold.error));
  assert.equal(await readFile(document, 'utf8'), before);
});

it('reconciles after a genuine concurrent selector conflict without ending its service lane', { timeout: 10_000 }, async t => {
  let principal = '';
  let paused = false;
  let entered = () => {};
  let release = () => {};
  const gateEntered = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const gate: Gate = async (operation, actor) => {
    if (operation.kind === 'commit' && actor.principal === principal && !paused) {
      paused = true;
      entered();
      await held;
    }
    return 'pass';
  };
  t.after(release);
  const { admin, board } = await fixture(t, true, [gate]);
  principal = `n:${board.$id}`;

  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: '/boards/ideas/first', ops: { $set: { votes: 5 } } },
  ] }).outcome;
  await gateEntered;
  await admin.session.commit({ opId: admin.key(), changes: [
    { op: 'patch', path: '/boards/ideas/first', ops: { $set: { votes: 6 } } },
  ] }).outcome;
  release();
  const approved = await admin.until('/boards/ideas/first', node => node.status === 'approved');
  assert.equal(approved.votes, 6);
  assert.deepEqual(approved.authored, { retained: true });
});
