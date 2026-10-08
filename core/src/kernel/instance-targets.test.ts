import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';

import { KernelError } from '#errors';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { createMemoryStore } from '#kernel/store/memory';
import type {
  ModuleManifest,
  OpenedStoreMountTarget,
  Position,
  StoredNode,
} from '#kernel/types';

it('refuses a cold target identity collision before effects and keeps the accepted root usable', { timeout: 10_000 }, async t => {
  const id = randomUUID();
  const root = createMemoryStore({ domain: `root:${id}` });
  let saved: Position | undefined;
  let saves = 0;
  let closes = 0;
  let duplicateId = '';

  const module: ModuleManifest = {
    id: 'example',
    types: [{
      name: 'example.mount', module: 'example', security: 'user-capability', version: 0,
      schema: {
        type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } },
      },
      actions: {},
    }],
    security: [{
      type: 'example.mount', context: 'mount',
      async handler() {
        const store = createMemoryStore({ domain: `target:${randomUUID()}` });
        const pos = { instance: id, epoch: 0, seq: 0 };
        const node: StoredNode = {
          $id: duplicateId, $path: '/data/doc', $type: 't.dir', $pos: pos,
        };
        await store.commit({
          pos, writerEpoch: 1, writes: [{ path: node.$path, node }],
          record: {
            pos, kind: 'kernel', executor: 'kernel', caller: 'kernel',
            entries: [{ id: node.$id, path: node.$path, change: { t: 'create', after: node } }],
          },
        });

        const target: OpenedStoreMountTarget = {
          kind: 'store', store,
          resources: {
            writerEpoch: 1, epoch: randomUUID(), persistent: false, decisionHistory: 'fresh',
          },
          async close() { closes++; store.close(); },
        };
        return target;
      },
    }],
    open: [],
  };
  const instance = await createInstance({
    id, root: { kind: 'store', store: root }, modules: [module], blobs: createMemoryBlobStore(),
    provisioning: {
      writerEpoch: 1,
      domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      counter: {
        async load() { return saved; },
        async save(pos) { saves++; saved = pos; },
        async freshEpoch(floor) { return floor + 1; },
      },
      bootstrap: {
        kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'test-password' },
      },
    },
  });
  t.after(() => instance.close());
  duplicateId = instance.bootstrap.adminId;
  assert.ok(instance.setupCredential);
  const admission = await instance.auth.openCredential(instance.setupCredential);
  const admin = instance.commands(admission);

  await admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    changes: [{
      op: 'put', node: {
        $path: '/data', $type: 't.dir', '#mount': { $type: 'example.mount', pattern: '' },
      },
    }],
  });
  // The accepted identity index must protect nodes beyond the bounded cache's residency.
  await instance.commit(Array.from({ length: 40 }, (_, index) => ({
    op: 'put' as const,
    node: { $path: `/bulk/${index}`, $type: 't.dir', payload: 'x'.repeat(240 * 1024) },
  })), {
    actor: admission.actor, executor: admission.actor.principal, caller: admission.actor.principal,
  });
  assert.equal(instance.writer.cache.get(duplicateId), undefined);
  const intake = instance.writer.intake;
  const rootCommit = t.mock.method(root, 'commit');
  const savedCount = saves;

  await assert.rejects(admin.read({ node: '/data/doc' }),
    error => error instanceof KernelError && error.code === 'INVALID');
  assert.equal(closes, 1);
  assert.equal(rootCommit.mock.callCount(), 0);
  assert.equal(saves, savedCount);
  assert.deepEqual(instance.writer.intake, intake);
  assert.equal((await admin.read({ node: '/admin' })).list.length, 1);
});
