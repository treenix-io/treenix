import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { createTwpClient } from '#client/twp';
import { createTestInstance } from '#kernel/testing';
import type { Connection, ModuleManifest } from '#kernel/types';
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
