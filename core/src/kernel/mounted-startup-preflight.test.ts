import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';

import { KernelError } from '#errors';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { scanBudget } from '#kernel/store/contract';
import { createMemoryStore } from '#kernel/store/memory';
import type { OpenedStoreMountTarget } from '#kernel/types';

for (const borrowedAlias of [false, true]) {
  it(
    borrowedAlias
      ? 'preserves borrowed root when an invalid startup target aliases its Store'
      : 'releases acquired startup resources after canonical preflight refusal without touching borrowed root',
    { timeout: 10_000 },
    async () => {
      const root = createMemoryStore({ domain: 'preflight-root' });
      const store = borrowedAlias ? root : createMemoryStore({ domain: 'preflight-target' });
      let closes = 0;
      let counterLoads = 0;
      const target: OpenedStoreMountTarget = {
        kind: 'store', store,
        resources: {
          writerEpoch: 1, epoch: randomUUID(), persistent: false, decisionHistory: 'fresh',
        },
        async close() {
          closes++;
          store.close();
        },
      };

      try {
        await assert.rejects(createInstance({
          id: 'startup-preflight', root: { kind: 'store', store: root }, modules: [],
          blobs: createMemoryBlobStore(),
          provisioning: {
            writerEpoch: 1, domains: [], credentialTtlMs: 60_000,
            counter: {
              async load() { counterLoads++; return undefined; },
              async save() { throw new Error('Preflight must not persist a position'); },
              async freshEpoch() { throw new Error('Preflight must not issue an epoch'); },
            },
            mounts: [{ node: randomUUID(), component: '#mount', revision: 'unadmitted', target }],
            bootstrap: {
              kind: 'fresh',
              admin: { path: '/admin', name: 'admin', password: 'test-password' },
            },
          },
        }), error => error instanceof KernelError && error.code === 'INVALID');

        assert.equal(counterLoads, 0);
        assert.equal(closes, borrowedAlias ? 0 : 1);
        assert.deepEqual((await root.scan({ range: { node: '/' }, budget: scanBudget() })).items, []);
      } finally {
        store.close();
        root.close();
      }
    },
  );
}
