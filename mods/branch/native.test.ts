import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { R, W, A, type ModuleManifest, type Session, type StoreBindingBody } from '@treenx/core/kernel/types';
import { nativeBranchManifest } from './native';

async function read(session: Session, path: string) {
  const copy = (await session.read({ node: path })).copies[0];
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

// The fixture owns stored branch configuration and genuine caller/node execution paths.
const fixture: ModuleManifest = { id: 'branch-fixture', security: [], open: [], types: [
  { name: 'branch.fixture', module: 'branch-fixture', security: 'ordinary', version: 0,
    schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
    actions: { increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } } } },
  { name: 'branch.executor', module: 'branch-fixture', security: 'user-capability', version: 0,
    schema: { type: 'object' }, actions: { increment: { kind: 'setuid', args: {}, async handler(ctx) {
      ctx.change.patch(`${ctx.node.$path}/state`, { $inc: { count: 1 } });
    } } } },
] };

test('native branch reads its authorized lower and commits future changes only to upper', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(resolve('temp/native-branch-normal-'));
  const runtime = await openNativeRuntime({ id: randomUUID(), directory, rootExternal: 'none', credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'branch-test-password' }, modules: [fixture, nativeBranchManifest()] });
  assert.ok(runtime.instance.setupCredential);
  const session = await runtime.instance.openSession(runtime.instance.setupCredential);
  const delivery = (async () => { for await (const _frame of session.lane) {} })();
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  const view = '/branches/b/tree', delta = '/branches/b/delta';
  try {
    await session.commit({ opId: key(), changes: [
      { op: 'put', node: { $path: '/live', $type: 'branch.fixture', count: 0 } },
      { op: 'put', node: { $path: '/live/item', $type: 'branch.fixture', count: 1 } },
      { op: 'put', node: { $path: '/branches', $type: 't.dir' } },
      { op: 'put', node: { $path: '/branches/b', $type: 't.branch', base: '/live', owner: 'fixture', status: 'open', title: '', createdAt: 0, mergedAt: 0, conflicts: [], '#mount': { $type: 't.mount.branch', pattern: 'tree' } } },
      { op: 'put', node: { $path: delta, $type: 't.dir' } },
      { op: 'put', node: { $path: view, $type: 't.dir' } },
    ] }).outcome;
    const original = await read(session, `${view}/item`), lower = await read(session, '/live/item');
    assert.equal(original.count, 1);
    assert.notEqual(original.$id, lower.$id);
    await session.act({ opId: key(), path: view, action: 'increment', args: {} }).outcome;
    assert.equal((await read(session, view)).count, 1);
    assert.equal((await read(session, '/live')).count, 0);
    assert.equal((await read(session, delta)).$type, 't.dir');
    await session.commit({ opId: key(), changes: [{ op: 'patch', path: `${view}/item`, ops: { $inc: { count: 1 } } }] }).outcome;
    assert.equal((await read(session, `${view}/item`)).$id, original.$id);
    assert.equal((await read(session, `${view}/item`)).count, 2);
    await session.act({ opId: key(), path: `${view}/item`, action: 'increment', args: {} }).outcome;
    assert.equal((await read(session, `${view}/item`)).count, 3);
    assert.deepEqual(await read(session, '/live/item'), lower);
    const stored = await read(session, `${delta}/item`);
    const future = getComponent<{ node: StoreBindingBody }>(stored, 't.branch.delta');
    assert.ok(future);
    assert.equal(future.node.$acl, undefined); assert.equal(future.node.$owner, undefined);

    await session.commit({ opId: key(), changes: [{ op: 'remove', path: `${view}/item` }] }).outcome;
    await assert.rejects(read(session, `${view}/item`), error => error instanceof KernelError && error.code === 'NOT_FOUND');
    assert.equal((await read(session, `${delta}/item`)).$type, 't.branch.whiteout');
    await session.commit({ opId: key(), changes: [
      { op: 'put', node: { $path: `${view}/item`, $type: 'branch.fixture', count: 9 } },
      { op: 'put', node: { $path: `${view}/created`, $type: 'branch.fixture', count: 5 } },
    ] }).outcome;
    assert.notEqual((await read(session, `${view}/item`)).$id, original.$id);
    assert.equal((await read(session, `${view}/item`)).count, 9);
    assert.deepEqual(await read(session, '/live/item'), lower);
    await assert.rejects(read(session, '/live/created'), error => error instanceof KernelError && error.code === 'NOT_FOUND');
    const children = await session.read({ children: view });
    assert.deepEqual(children.copies.map(copy => {
      if ('error' in copy) throw copy.error;
      return copy.node.$path;
    }), [`${view}/created`, `${view}/item`]);

    const anonymous = await runtime.instance.openSession();
    const lane = anonymous.lane[Symbol.asyncIterator](), welcome = await lane.next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    const principal = welcome.value.principal;
    const anonymousDelivery = (async () => { while (!(await lane.next()).done) {} })();
    try {
      await session.commit({ opId: key(), changes: [
        { op: 'patch', path: '/', ops: { $set: { $acl: [
          { subject: { group: 'admins' }, grant: R | W | A }, { subject: { group: principal }, grant: R },
        ] } } },
      ] }).outcome;
      assert.equal((await read(anonymous, `${view}/item`)).count, 9);
      await session.commit({ opId: key(), changes: [
        { op: 'patch', path: view, ops: { $set: { $acl: [{ subject: { group: principal }, grant: R | W }] } } },
        { op: 'patch', path: delta, ops: { $set: { $acl: [{ subject: { group: principal }, grant: R | W }] } } },
      ] }).outcome;
      await anonymous.commit({ opId: key(), changes: [{ op: 'patch', path: `${view}/item`, ops: { $inc: { count: 1 } } }] }).outcome;
      assert.equal((await read(anonymous, `${view}/item`)).count, 10);
      assert.deepEqual(await read(session, '/live/item'), lower);
      await session.commit({ opId: key(), changes: [
        { op: 'patch', path: '/live/item', ops: { $set: { $acl: [{ subject: { group: principal }, deny: R }] } } },
      ] }).outcome;
      // A fresh upper identity still retains the actual lower authorization proof.
      await assert.rejects(read(anonymous, `${view}/item`), error => error instanceof KernelError && error.code === 'NOT_FOUND');
      await assert.rejects(anonymous.commit({ opId: key(), changes: [{ op: 'patch', path: `${view}/item`, ops: { $inc: { count: 1 } } }] }).outcome,
        error => error instanceof KernelError && error.code === 'NOT_FOUND');
    } finally { anonymous.close(); await anonymousDelivery; }
  } finally { session.close(); await delivery; await runtime.close(); }
});


test('native branch lifecycle creates, reviews and merges one bounded atomic future', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(resolve('temp/native-branch-lifecycle-'));
  const runtime = await openNativeRuntime({ id: randomUUID(), directory, rootExternal: 'none', credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'branch-test-password' }, modules: [fixture, nativeBranchManifest()] });
  assert.ok(runtime.instance.setupCredential);
  const session = await runtime.instance.openSession(runtime.instance.setupCredential);
  const delivery = (async () => { for await (const _frame of session.lane) {} })();
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  async function branches() {
    return (await session.read({ children: '/branches' })).copies.map(copy => {
      if ('error' in copy) throw copy.error;
      return copy.node;
    });
  }
  try {
    await session.commit({ opId: key(), changes: [
      { op: 'put', node: { $path: '/live', $type: 't.dir' } },
      { op: 'put', node: { $path: '/live/item', $type: 'branch.fixture', count: 1 } },
      { op: 'put', node: { $path: '/live/remove', $type: 'branch.fixture', count: 2 } },
      { op: 'put', node: { $path: '/branches', $type: 't.branches' } },
    ] }).outcome;
    await session.act({ opId: key(), path: '/branches', action: 'create', args: { base: '/live', title: 'Future' } }).outcome;
    const branch = (await branches())[0], view = `${branch.$path}/tree`;
    assert.equal(branch.status, 'open');
    await session.commit({ opId: key(), changes: [
      { op: 'patch', path: `${view}/item`, ops: { $inc: { count: 1 } } },
      { op: 'put', node: { $path: `${view}/created`, $type: 'branch.fixture', count: 6 } },
      { op: 'remove', path: `${view}/remove` },
    ] }).outcome;
    const difference = await session.act({ opId: key(), path: branch.$path, action: 'diff', args: {} }).outcome;
    assert.ok(difference.value);
    assert.equal((await read(session, '/live/item')).count, 1);
    await session.act({ opId: key(), path: branch.$path, action: 'requestMerge', args: { note: 'Ready' } }).outcome;
    assert.equal((await read(session, branch.$path)).status, 'review');
    const merged = await session.act({ opId: key(), path: branch.$path, action: 'merge', args: {} }).outcome;
    assert.deepEqual(merged.value, { merged: 3, applied: ['/live/created', '/live/item', '/live/remove'], conflicts: [], status: 'merged' });
    assert.equal((await read(session, branch.$path)).status, 'merged');
    assert.equal((await read(session, '/live/item')).count, 2);
    assert.equal((await read(session, '/live/created')).count, 6);
    await assert.rejects(read(session, '/live/remove'), error => error instanceof KernelError && error.code === 'NOT_FOUND');
    await assert.rejects(session.act({ opId: key(), path: branch.$path, action: 'abandon', args: {} }).outcome,
      error => error instanceof KernelError && error.code === 'CONFLICT');

    await session.act({ opId: key(), path: '/branches', action: 'create', args: { base: '/live' } }).outcome;
    const discard = (await branches()).find(node => node.$path !== branch.$path);
    assert.ok(discard);
    await session.act({ opId: key(), path: discard.$path, action: 'abandon', args: {} }).outcome;
    assert.equal((await read(session, discard.$path)).status, 'abandoned');
  } finally { session.close(); await delivery; await runtime.close(); }
});


test('native branch restores node executor identity before the first projected read', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(resolve('temp/native-branch-reopen-'));
  const config = { id: randomUUID(), directory, rootExternal: 'none' as const, credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'branch-test-password' }, modules: [fixture, nativeBranchManifest()] };
  const runtime = await openNativeRuntime(config);
  const credential = runtime.instance.setupCredential;
  assert.ok(credential);
  const session = await runtime.instance.openSession(credential);
  const delivery = (async () => { for await (const _frame of session.lane) {} })();
  const view = '/branches/b/tree', upper = '/branches/b/delta';
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  let identity: string;
  try {
    await session.commit({ opId: key(), changes: [
      { op: 'put', node: { $path: '/live', $type: 't.dir' } },
      { op: 'put', node: { $path: '/live/executor', $type: 'branch.executor' } },
      { op: 'put', node: { $path: '/live/executor/state', $type: 'branch.fixture', count: 0 } },
      { op: 'put', node: { $path: '/branches', $type: 't.dir' } },
      { op: 'put', node: { $path: '/branches/b', $type: 't.branch', base: '/live', owner: 'fixture', status: 'open', title: '', createdAt: 0, mergedAt: 0, conflicts: [], '#mount': { $type: 't.mount.branch', pattern: 'tree' } } },
      { op: 'put', node: { $path: upper, $type: 't.dir' } },
      { op: 'put', node: { $path: view, $type: 't.dir' } },
    ] }).outcome;
    const executor = await read(session, `${view}/executor`);
    identity = executor.$id;
    await session.commit({ opId: key(), expect: { nodes: [{ path: executor.$path, rev: executor.$rev }] }, changes: [
      { op: 'patch', path: '/live', ops: { $set: { $acl: [{ subject: { group: `n:${identity}` }, grant: R }] } } },
      { op: 'patch', path: view, ops: { $set: { $acl: [{ subject: { group: `n:${identity}` }, grant: R | W }] } } },
      { op: 'patch', path: upper, ops: { $set: { $acl: [{ subject: { group: `n:${identity}` }, grant: R | W }] } } },
    ] }).outcome;
    await session.commit({ opId: key(), changes: [{ op: 'patch', path: `${view}/executor/state`, ops: { $inc: { count: 1 } } }] }).outcome;
  } finally { session.close(); await delivery; await runtime.close(); }

  const reopened = await openNativeRuntime({ ...config, installerCredential: credential });
  const caller = await reopened.instance.openSession(credential);
  const reopenedDelivery = (async () => { for await (const _frame of caller.lane) {} })();
  try {
    await caller.act({ opId: { epoch: reopened.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
      path: `${view}/executor`, action: 'increment', args: {} }).outcome;
    assert.equal((await read(caller, `${view}/executor`)).$id, identity);
    assert.equal((await read(caller, `${view}/executor/state`)).count, 2);
    assert.equal((await read(caller, '/live/executor/state')).count, 0);
  } finally { caller.close(); await reopenedDelivery; await reopened.close(); }
});


test('native branch adopts root and new cross-referenced futures in one decision', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(resolve('temp/native-branch-adopt-'));
  const runtime = await openNativeRuntime({ id: randomUUID(), directory, rootExternal: 'none', credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'branch-test-password' }, modules: [fixture, nativeBranchManifest()] });
  assert.ok(runtime.instance.setupCredential);
  const session = await runtime.instance.openSession(runtime.instance.setupCredential);
  const delivery = (async () => { for await (const _frame of session.lane) {} })();
  const key = () => ({ epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() });
  try {
    await session.commit({ opId: key(), changes: [
      { op: 'put', node: { $path: '/live', $type: 'branch.fixture', count: 0 } },
      { op: 'put', node: { $path: '/live/retained', $type: 'branch.fixture', count: 7 } },
      { op: 'put', node: { $path: '/branches', $type: 't.branches' } },
    ] }).outcome;
    const original = await read(session, '/live'), retained = await read(session, '/live/retained');
    await session.act({ opId: key(), path: '/branches', action: 'create', args: { base: '/live' } }).outcome;
    const branchCopy = (await session.read({ children: '/branches' })).copies[0];
    if ('error' in branchCopy) throw branchCopy.error;
    const branch = branchCopy.node, view = `${branch.$path}/tree`, upper = `${branch.$path}/delta`;
    await session.commit({ opId: key(), changes: [
      { op: 'patch', path: view, ops: { $set: { count: 3 } } },
      { op: 'put', node: { $path: `${view}/created`, $type: 'branch.fixture', count: 9 } },
    ] }).outcome;
    const futureRoot = await read(session, view), futureLeaf = await read(session, `${view}/created`);
    await session.commit({ opId: key(), changes: [
      { op: 'patch', path: view, ops: { $set: { target: { $type: 'ref', $ref: futureLeaf.$path, $refId: futureLeaf.$id } } } },
      { op: 'patch', path: futureLeaf.$path, ops: { $set: { $refs: [{ $type: 'ref', $ref: view, $refId: futureRoot.$id }] } } },
    ] }).outcome;
    const merged = await session.act({ opId: key(), path: branch.$path, action: 'merge', args: {} }).outcome;
    assert.deepEqual(merged.value, { merged: 2, applied: ['/live', '/live/created'], conflicts: [], status: 'merged' });
    assert.ok(merged.pos);
    const live = await read(session, '/live'), leaf = await read(session, '/live/created');
    assert.equal(live.$id, original.$id);
    assert.equal(leaf.$id, futureLeaf.$id);
    assert.equal(live.count, 3);
    assert.equal(leaf.count, 9);
    assert.deepEqual(live.target, { $type: 'ref', $ref: '/live/created', $refId: leaf.$id });
    assert.deepEqual(leaf.$refs, [{ $type: 'ref', $ref: '/live', $refId: live.$id }]);
    assert.deepEqual(await read(session, '/live/retained'), retained);
    const upperRoot = await read(session, upper), whiteout = await read(session, `${upper}/created`);
    assert.ok(getComponent(upperRoot, 't.branch.whiteout'));
    assert.equal(whiteout.$type, 't.branch.whiteout');
    const status = await read(session, branch.$path);
    assert.equal(live.$rev, leaf.$rev);
    assert.equal(live.$rev, upperRoot.$rev);
    assert.equal(live.$rev, whiteout.$rev);
    assert.equal(live.$rev, status.$rev);
  } finally { session.close(); await delivery; await runtime.close(); }
});
