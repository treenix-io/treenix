// Typed subscriptions exercise the actual native lane, including deletion and recreation.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { it, type TestContext } from 'node:test';
import { createInstanceFoundation } from '#kernel/instance';
import { createMemoryStore } from '#kernel/store/memory';
import { createTwpHttpServer } from '#server/http-twp';
import { openTwpHttp } from './http-twp';
import { createTwpClient } from './twp';
import { createNodeClient } from './handle';
import type { ModuleManifest, Position } from '#kernel/types';

class Doc {
  static $type = 'test.doc';
  title = '';
  rename(): void {
    throw new Error('The client must call the native action');
  }
}

const manifest: ModuleManifest = {
  id: 'typed-client',
  types: [
    {
      name: 'test.doc',
      module: 'typed-client',
      security: 'ordinary',
      version: 0,
      schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      actions: {
        rename: {
          kind: 'write',
          args: { type: 'object' },
          post: { '': { $set: { title: 'renamed' } } },
        },
      },
    },
  ],
  security: [],
  open: [],
};

/** Give each public client its own authenticated HTTP connection to a real kernel. */
async function fixture(t: TestContext) {
  const id = randomUUID(),
    root = createMemoryStore({ domain: id });
  let saved: Position | undefined;
  const instance = await createInstanceFoundation({
    id,
    root,
    writerEpoch: 1,
    domains: [{ store: root, epoch: id, persistent: false }],
    counter: {
      async load() {
        return saved;
      },
      async save(pos) {
        saved = pos;
      },
      async freshEpoch(floor) {
        return floor + 1;
      },
    },
    firstAdmin: { path: '/admin', name: 'admin', password: 'typed-client-password' },
    initialCredential: { ttlMs: 60_000 },
  });
  assert.ok(instance.setupCredential);
  const credential = instance.setupCredential;
  const admin = instance.commands(await instance.auth.openCredential(credential));
  await admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    changes: [
      {
        op: 'put',
        node: {
          $path: '/sys/types/test.doc',
          $type: 't.type',
          name: 'test.doc',
          module: manifest.id,
          security: 'ordinary',
        },
      },
    ],
  });
  instance.registry.publish(manifest);
  await admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    changes: [{ op: 'put', node: { $path: '/d', $type: 'test.doc', title: 'v1' } }],
  });
  const http = createTwpHttpServer({ instance, allowedOrigins: [], credentialTtlMs: 60_000 });
  http.server.listen(0, '127.0.0.1');
  await once(http.server, 'listening');
  const address = http.server.address();
  assert.ok(address !== null && typeof address === 'object');
  const connection = await openTwpHttp({ url: `http://127.0.0.1:${address.port}`, credential });
  const client = createTwpClient(connection, { credential, close: connection.close });
  t.after(async () => {
    client.close();
    await http.close();
    admin.close();
    instance.auth.close();
  });
  await client.ready;
  return { client, handle: createNodeClient(client)('/d') };
}

function signal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it(
  'fetches typed data and invokes its native action without a caller-side fetch',
  { timeout: 10_000 },
  async (t) => {
    const { handle } = await fixture(t);
    await handle.get(Doc).rename();
    assert.equal((await handle.fetch(Doc)).title, 'renamed');
  },
);

it('notifies with typed data on native updates', { timeout: 10_000 }, async (t) => {
  const { client, handle } = await fixture(t),
    updated = signal();
  const seen: string[] = [];
  const sub = await handle.sub(Doc, (doc) => {
    seen.push(doc.title);
    if (doc.title === 'v2') updated.resolve();
  });
  try {
    await client.commit({ changes: [{ op: 'patch', path: '/d', ops: { $set: { title: 'v2' } } }] })
      .outcome;
    await updated.promise;
    assert.deepEqual(seen, ['v1', 'v2']);
  } finally {
    sub.unsubscribe();
  }
});

it('fires onRemove when the watched node is deleted', { timeout: 10_000 }, async (t) => {
  const { client, handle } = await fixture(t),
    removed = signal();
  let count = 0;
  const sub = await handle.sub(Doc, () => {}, {
    onRemove: () => {
      count++;
      removed.resolve();
    },
  });
  try {
    await client.commit({ changes: [{ op: 'remove', path: '/d' }] }).outcome;
    await removed.promise;
    assert.equal(count, 1);
  } finally {
    sub.unsubscribe();
  }
});

it('clears the removed node before delivering its replacement', { timeout: 10_000 }, async (t) => {
  const { client, handle } = await fixture(t),
    removed = signal(),
    recreated = signal();
  const seen: string[] = [];
  const sub = await handle.sub(
    Doc,
    (doc) => {
      seen.push(doc.title);
      if (doc.title === 'reborn') recreated.resolve();
    },
    { onRemove: removed.resolve },
  );
  try {
    await client.commit({ changes: [{ op: 'remove', path: '/d' }] }).outcome;
    await removed.promise;
    await client.commit({
      changes: [{ op: 'put', node: { $path: '/d', $type: 'test.doc', title: 'reborn' } }],
    }).outcome;
    await recreated.promise;
    assert.deepEqual(seen, ['v1', 'reborn']);
  } finally {
    sub.unsubscribe();
  }
});
