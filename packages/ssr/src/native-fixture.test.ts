import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Position } from '@treenx/core/kernel/types';
import { createInstanceFoundation } from '../../../core/src/kernel/instance';
import { createMemoryStore } from '../../../core/src/kernel/store/memory';
import { ssrModule } from '#kernel';

export async function nativeFixture(t: TestContext) {
  const root = createMemoryStore({ domain: 'ssr' });
  let saved: Position | undefined;
  const instance = await createInstanceFoundation({
    id: 'ssr',
    root,
    writerEpoch: 1,
    domains: [{ store: root, epoch: 'memory', persistent: false }],
    modules: [ssrModule],
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
    firstAdmin: { path: '/admin', name: 'admin', password: 'native-ssr-password' },
    initialCredential: { ttlMs: 60_000 },
  });
  t.after(() => instance.close());
  assert.ok(instance.setupCredential);
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential));
  t.after(() => admin.close());
  let nonce = 0;
  const key = () => ({
    epoch: instance.writer.intake.epoch,
    time: Date.now(),
    nonce: `ssr:${nonce++}`,
  });
  await admin.commit({
    opId: key(),
    changes: ssrModule.types.map((type) => ({
      op: 'put' as const,
      node: {
        $path: `/sys/types/${type.name}`,
        $type: 't.type',
        name: type.name,
        module: type.module,
        security: type.security,
      },
    })),
  });
  instance.registry.publish(ssrModule);
  return { instance, admin, key };
}
