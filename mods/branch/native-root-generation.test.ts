import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { R, W, type ModuleManifest, type Session } from '@treenx/core/kernel/types';
import { nativeBranchManifest } from './native';

async function read(session: Session, path: string) {
  const copy = (await session.read({ node: path })).copies[0];
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

const fixture: ModuleManifest = { id: 'branch-generation', security: [], open: [], types: [
  { name: 'branch.generation', module: 'branch-generation', security: 'user-capability', version: 0,
    schema: { type: 'object' }, actions: { increment: { kind: 'setuid', args: {}, async handler(ctx) {
      ctx.change.patch(ctx.node.$path, { $inc: { count: 1 } });
    } } } },
] };

test('future root recreation retires its issued identity and persists a fresh generation', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(resolve('temp/native-root-generation-'));
  const config = { id: randomUUID(), directory, credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'generation-test-password' }, modules: [fixture, nativeBranchManifest()] };
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
      { op: 'put', node: { $path: '/live', $type: 'branch.generation', count: 0 } },
      { op: 'put', node: { $path: '/branches', $type: 't.dir' } },
      { op: 'put', node: { $path: '/branches/b', $type: 't.branch', base: '/live', owner: 'fixture', status: 'open', title: '', createdAt: 0, mergedAt: 0, conflicts: [], '#mount': { $type: 't.mount.branch', pattern: 'tree' } } },
      { op: 'put', node: { $path: upper, $type: 't.dir' } },
      { op: 'put', node: { $path: `${upper}/retained`, $type: 't.branch.delta', baseId: null, baseRev: null,
        node: { $path: `${view}/retained`, $type: 't.dir', value: 7 } } },
      { op: 'put', node: { $path: view, $type: 't.dir' } },
    ] }).outcome;
    const retained = await read(session, `${upper}/retained`);
    const ids = new Set<string>([(await read(session, view)).$id]);
    for (let count = 1; count <= 2; count++) {
      await session.commit({ opId: key(), changes: [{ op: 'remove', path: view }] }).outcome;
      await assert.rejects(read(session, view), error => error instanceof KernelError && error.code === 'NOT_FOUND');
      await session.commit({ opId: key(), changes: [{ op: 'put', node: { $path: view, $type: 'branch.generation', count } }] }).outcome;
      const current = await read(session, view);
      assert.ok(!ids.has(current.$id));
      ids.add(current.$id);
      assert.equal((await read(session, upper)).$type, 't.dir');
      assert.equal((await read(session, `${upper}/retained`)).$id, retained.$id);
      if (count === 1) {
        await session.commit({ opId: key(), expect: { nodes: [{ path: current.$path, rev: current.$rev }] }, changes: [
          { op: 'patch', path: '/live', ops: { $set: { $acl: [{ subject: { group: `n:${current.$id}` }, grant: R }] } } },
          { op: 'patch', path: '/branches/b', ops: { $set: { $acl: [{ subject: { group: `n:${current.$id}` }, grant: R | W }] } } },
        ] }).outcome;
      }
    }
    identity = (await read(session, view)).$id;
    await assert.rejects(session.act({ opId: key(), path: view, action: 'increment', args: {} }).outcome,
      error => error instanceof KernelError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN'));
  } finally { session.close(); await delivery; await runtime.close(); }
  const reopened = await openNativeRuntime({ ...config, installerCredential: credential });
  const caller = await reopened.instance.openSession(credential);
  const reopenedDelivery = (async () => { for await (const _frame of caller.lane) {} })();
  try {
    assert.equal((await read(caller, view)).$id, identity);
    assert.equal((await read(caller, view)).count, 2);
  } finally { caller.close(); await reopenedDelivery; await reopened.close(); }
});
