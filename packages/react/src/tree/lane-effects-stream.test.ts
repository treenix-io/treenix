import assert from 'node:assert/strict';
import { it } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { createTwpClient } from '@treenx/core/client/twp';
import type { ModuleManifest, Position, Request } from '@treenx/core/kernel/types';
import { createInstanceFoundation } from '../../../../core/src/kernel/instance';
import { createMemoryStore } from '../../../../core/src/kernel/store/memory';
import { createLaneTreeClient } from '#tree/lane-tree-client';
import { createLaneEffects } from '#tree/lane-effects';

/** Observe real handler progress without a clock or a replacement delivery channel. */
function event() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('cancels its actual pending stream while next is waiting and leaves the admitted lane usable', async t => {
  const advanced = event(), ended = event(), release = event();
  const heldSecond = event(), heldThird = event();
  let fast = false, received = 0;
  const module: ModuleManifest = { id: 'public-stream-owner', security: [], open: [], types: [{
    name: 'test.public-stream', module: 'public-stream-owner', security: 'ordinary', version: 0, schema: {},
    actions: { pieces: { kind: 'read', args: {}, async *handler() {
      try {
        yield 'first';
        advanced.resolve();
        await release.promise;
        yield 'second';
      } finally { ended.resolve(); }
    } }, fast: { kind: 'read', args: {}, async *handler() {
      for (let piece = 0; piece < 4096; piece++) yield piece;
    } } },
  }] };
  const root = createMemoryStore({ domain: 'public-stream-owner' });
  let saved: Position | undefined;
  const instance = await createInstanceFoundation({ id: 'public-stream-owner', root, writerEpoch: 1,
    domains: [{ store: root, epoch: 'memory', persistent: false }],
    counter: { async load() { return saved; }, async save(pos) { saved = pos; }, async freshEpoch(floor) { return floor + 1; } },
    firstAdmin: { path: '/admin', name: 'admin', password: 'stream-owner-password' }, initialCredential: { ttlMs: 60_000 } });
  t.after(() => instance.auth.close());
  assert.ok(instance.setupCredential);
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential)); t.after(() => admin.close());
  await admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'type' }, changes: [{ op: 'put',
    node: { $path: '/sys/types/test.public-stream', $type: 't.type', name: 'test.public-stream', module: module.id, security: 'ordinary' } }] });
  instance.registry.publish(module);
  await admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'node' }, changes: [{ op: 'put',
    node: { $path: '/stream', $type: 'test.public-stream' } }] });
  const lane = await instance.openSession(instance.setupCredential), sent: Request[] = [];
  const client = createTwpClient({ frames: { async *[Symbol.asyncIterator]() {
    for await (const frame of lane.frames) {
      if (fast && frame.t === 'chunk') {
        received++;
        if (received === 2) heldSecond.resolve();
        if (received === 3) heldThird.resolve();
      }
      yield frame;
    }
  } }, send(request) {
    sent.push(request);
    if (request.t === 'hi' || request.t === 'read' && 'history' in request.selector)
      throw new KernelError('INVALID', 'Unexpected command on admitted node lane');
    lane.accept(request);
  } }, { close: () => lane.close() });
  const owner = createLaneTreeClient(client); t.after(() => owner.close());
  const effects = createLaneEffects(owner); t.after(() => effects.close());
  const pieces = effects.effects.stream({ path: '/stream', action: 'pieces' });
  assert.deepEqual(await pieces.next(), { done: false, value: 'first' });
  const waiting = pieces.next();
  await advanced.promise;
  assert.deepEqual(await pieces.return?.(), { done: true, value: undefined });
  assert.deepEqual(await waiting, { done: true, value: undefined });
  release.resolve();
  await ended.promise;
  assert.equal(sent.filter(request => request.t === 'cancel').length, 1);
  const result = await owner.read({ node: '/stream' });
  assert.equal(result.list.length, 1);
  fast = true;
  const rapid = effects.effects.stream({ path: '/stream', action: 'fast' });
  assert.deepEqual(await rapid.next(), { done: false, value: 0 });
  await heldSecond.promise;
  await Promise.resolve();
  assert.equal(received, 2);
  assert.deepEqual(await rapid.next(), { done: false, value: 1 });
  await heldThird.promise;
  await Promise.resolve();
  assert.equal(received, 3);
  assert.deepEqual(await rapid.return?.(), { done: true, value: undefined });
  const after = await owner.read({ node: '/stream' });
  assert.equal(after.list.length, 1);
  assert.equal(sent.filter(request => request.t === 'cancel').length, 2);
});
