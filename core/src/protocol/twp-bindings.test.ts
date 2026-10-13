import assert from 'node:assert/strict';
import { it } from 'node:test';
import { KernelError } from '#errors';
import { MessageChannel } from 'node:worker_threads';
import { createTwpClient } from '#client/twp';
import { createTestInstance } from '#kernel/testing';
import type { Connection, Frame, ModuleManifest, Request } from '#kernel/types';
import { openTwpLoopback } from '#protocol/twp-loopback';
import { createTwpPort } from '#protocol/twp-port';
import { serveTwpPort } from '#protocol/serve-port';

const module: ModuleManifest = {
  id: 'native-bindings',
  security: [],
  open: [],
  types: [
    {
      name: 'binding.counter',
      module: 'native-bindings',
      security: 'ordinary',
      version: 0,
      schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      actions: {
        increment: {
          kind: 'write',
          args: { type: 'object' },
          post: { '': { $inc: { count: 1 } } },
        },
        report: {
          kind: 'read',
          args: { type: 'object' },
          async *handler(ctx) {
            yield (await ctx.read.read({ node: '/counter' })).copies.length;
            return 'reported';
          },
        },
      },
    },
  ],
};

for (const transport of ['loopback', 'MessagePort']) {
  it(`uses native ${transport} for authenticated reads, live writes and streamed action results`, async (t) => {
    const fixture = await createTestInstance({
      modules: [module],
      actors: {},
      seed: [{ $path: '/counter', $type: 'binding.counter', count: 0 }],
    });
    t.after(() => fixture.close());
    assert.ok(fixture.instance.setupCredential);
    let connection: Connection & { close(): void };
    if (transport === 'loopback') {
      connection = await openTwpLoopback(fixture.instance, {
        credential: fixture.instance.setupCredential,
        origin: '127.0.0.1',
      });
    } else {
      const { port1, port2 } = new MessageChannel();
      const server = serveTwpPort(fixture.instance, port1, '127.0.0.1');
      t.after(() => server.close());
      connection = createTwpPort(port2, { credential: fixture.instance.setupCredential });
    }
    const client = createTwpClient(connection, {
      credential: fixture.instance.setupCredential,
      close: connection.close,
    });
    t.after(() => client.close());
    await client.ready;
    const subscription = client.sub({ node: '/counter' }, () => {});
    await subscription.ready;
    await client.act({ path: '/counter', action: 'increment', args: {} }).outcome;
    const copy = client.cache.at('/counter');
    assert.ok(copy && 'node' in copy);
    assert.equal(copy.node.count, 1);
    const report = client.act({ path: '/counter', action: 'report', args: {} });
    const chunks = [];
    for await (const chunk of report.chunks) chunks.push(chunk);
    assert.deepEqual(chunks, [1]);
    assert.equal((await report.outcome).value, 'reported');
    subscription.close();
  });
}

/** Coordinate transport interruption with actual admission or accepted delivery. */
function signal<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('replays a lost transport outcome under its original key without executing the action twice', { timeout: 10000 }, async (t) => {
  let executions = 0;
  const owner: ModuleManifest = { ...module, types: module.types.map((type) => ({
    ...type,
    actions: { ...type.actions, accepted: { kind: 'write', args: { type: 'object' },
      async handler(ctx) {
        executions++;
        ctx.change.patch('/counter', { $inc: { count: 1 } });
        return { receipt: 'original' };
      },
    } },
  })) };
  const fixture = await createTestInstance({ modules: [owner], actors: {},
    seed: [{ $path: '/counter', $type: 'binding.counter', count: 0 }] });
  t.after(() => fixture.close());
  const credential = fixture.instance.setupCredential;
  assert.ok(credential);
  const transport = await openTwpLoopback(fixture.instance, { credential, origin: '127.0.0.1' });
  const lost = signal<Extract<Frame, { t: 'done' }>>();
  const requests: Request[] = [];
  const connection: Connection = {
    send(request) { requests.push(request); transport.send(request); },
    frames: { async *[Symbol.asyncIterator]() {
      try {
        for await (const frame of transport.frames) {
          if (frame.t === 'done') { lost.resolve(frame); return; }
          yield frame;
        }
      } finally { transport.close(); }
    } },
  };
  const first = createTwpClient(connection, { credential, close: transport.close });
  t.after(() => first.close());
  await first.ready;
  const opId = first.key();
  const pending = first.act({ path: '/counter', action: 'accepted', args: {}, opId });
  const refused = assert.rejects(pending.outcome,
    (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
  const original = await lost.promise;
  await refused;

  const reopened = await openTwpLoopback(fixture.instance, { credential, origin: '127.0.0.1' });
  const retryRequests: Request[] = [];
  const retry = createTwpClient({ frames: reopened.frames,
    send(request) { retryRequests.push(request); reopened.send(request); } },
  { credential, close: reopened.close });
  t.after(() => retry.close());
  await retry.ready;
  const replayed = await retry.act({ path: '/counter', action: 'accepted', args: {}, opId }).outcome;
  assert.deepEqual(replayed, { pos: original.pos, value: original.value });
  assert.deepEqual(replayed.value, { receipt: 'original' });
  assert.equal(executions, 1);
  const request = requests.find((entry) => entry.t === 'act');
  const replay = retryRequests.find((entry) => entry.t === 'act');
  assert.ok(request?.t === 'act' && replay?.t === 'act');
  assert.deepEqual(request.opId, opId);
  assert.deepEqual(replay.opId, opId);
  const copy = (await retry.read({ node: '/counter' })).copies[0];
  assert.ok('node' in copy);
  assert.equal(copy.node.count, 1);
});

it('rejects an admitted in-flight request when its native transport detaches', { timeout: 10000 }, async (t) => {
  const entered = signal<void>();
  const release = signal<void>();
  const owner: ModuleManifest = { ...module, types: module.types.map((type) => ({
    ...type,
    actions: { ...type.actions, suspended: { kind: 'read', args: { type: 'object' },
      async handler() { entered.resolve(); await release.promise; return 'released'; },
    } },
  })) };
  const fixture = await createTestInstance({ modules: [owner], actors: {},
    seed: [{ $path: '/counter', $type: 'binding.counter', count: 0 }] });
  t.after(() => fixture.close());
  const credential = fixture.instance.setupCredential;
  assert.ok(credential);
  const transport = await openTwpLoopback(fixture.instance, { credential, origin: '127.0.0.1' });
  const client = createTwpClient(transport, { credential, close: transport.close });
  t.after(() => client.close());
  await client.ready;
  const pending = client.act({ path: '/counter', action: 'suspended', args: {} });
  const outcome = assert.rejects(pending.outcome,
    (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
  const chunks = assert.rejects(async () => { for await (const _ of pending.chunks) {} },
    (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
  await entered.promise;
  transport.close();
  try { await Promise.all([outcome, chunks]); }
  finally { release.resolve(); }
  assert.equal(client.failure()?.code, 'UNAVAILABLE');
});
