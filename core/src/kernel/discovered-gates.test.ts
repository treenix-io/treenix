import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { KernelError } from '#errors';
import { prepareCredential } from '#kernel/auth/credentials';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { createMemoryStore } from '#kernel/store/memory';
import { R, W, type Position } from '#kernel/types';
import { createMcpSession } from '@treenx/mods/mcp/mcp-session';

/** Default discovery must keep the Guardian predicate even while its service is absent. */
test(
  'direct native instance retains discovered and explicit Gates',
  { timeout: 10_000 },
  async () => {
    const id = randomUUID(),
      store = createMemoryStore({ domain: id });
    let saved: Position | undefined;
    let explicitCalls = 0;
    const instance = await createInstance({
      id,
      root: { kind: 'store', store },
      blobs: createMemoryBlobStore(),
      allowPartialMods: true,
      gates: [
        async () => {
          explicitCalls++;
          return 'pass';
        },
      ],
      provisioning: {
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
        writerEpoch: 1,
        domains: [{ store, epoch: 'discovery', persistent: false }],
        credentialTtlMs: 60_000,
        bootstrap: {
          kind: 'fresh',
          admin: { path: '/admin', name: 'admin', password: 'discovery-password' },
        },
      },
    });
    try {
      assert.equal(instance.registry.type('ai.guardian').module, 'treenix.guardian');
      const admin = await createMcpSession(await instance.openSession(instance.setupCredential));
      await admin.set_node({
        node: {
          $path: '/auth/users/agent',
          $type: 't.user',
          name: 'agent',
          status: 'active',
          '#groups': { $type: 't.groups', list: ['agent'] },
        },
      });
      const account = (await admin.get_node({ path: '/auth/users/agent' })).copies[0];
      if ('error' in account) throw account.error;
      await admin.set_node({
        node: {
          $path: '/work',
          $type: 't.dir',
          $acl: [{ subject: { group: `u:${account.node.$id}` }, grant: R | W }],
        },
      });
      const issued = prepareCredential(account.node.$id, {
        expiresAt: Date.now() + 60_000,
        scope: ['/work'],
      });
      await admin.set_node({ node: issued.node });
      const agent = await createMcpSession(await instance.openSession(issued.credential));
      assert.equal((await agent.get_node({ path: '/work' })).copies.length, 1);
      await assert.rejects(
        agent.set_node({ node: { $path: '/work/refused', $type: 't.dir' } }),
        (error) => error instanceof KernelError && error.code === 'REFUSED',
      );
      assert.ok(explicitCalls > 0);
    } finally {
      await instance.close();
      await store.close();
    }
  },
);
