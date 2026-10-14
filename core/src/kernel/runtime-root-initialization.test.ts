import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { KernelError } from '#errors';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { DEFAULT_LIMITS } from '#kernel/types';

it(
  'cold reopens a persistent root larger than ordinary read budgets while retaining saved request limits',
  { timeout: 45_000 },
  async (t) => {
    const parent = resolve('../../temp/root-initialization');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'dataset-'));
    const config = {
      directory,
      id: randomUUID(),
      credentialTtlMs: 60_000,
      modules: [],
      firstAdmin: { path: '/admin', name: 'admin', password: 'large-root-password' },
    };
    const first = await openNativeRuntime(config);
    t.after(() => first.close());
    assert.ok(first.instance.setupCredential);
    const credential = first.instance.setupCredential;
    const admin = await first.instance.openSession(credential),
      delivery = drainSession(admin);
    let nonce = 0;
    const key = () => ({
      epoch: first.instance.writer.intake.epoch,
      time: Date.now(),
      nonce: `large:${nonce++}`,
    });
    const count = DEFAULT_LIMITS.readNodes + 20,
      payload = 'x'.repeat(9000);
    assert.ok(count * payload.length > DEFAULT_LIMITS.readBytes);
    await admin.commit({
      opId: key(),
      changes: [{ op: 'put', node: { $path: '/records', $type: 't.dir' } }],
    }).outcome;
    for (let offset = 0; offset < count; offset += 30) {
      const size = Math.min(30, count - offset);
      await admin.commit({
        opId: key(),
        changes: Array.from({ length: size }, (_, index) => ({
          op: 'put' as const,
          node: { $path: `/records/n${offset + index}`, $type: 't.dir', payload },
        })),
      }).outcome;
    }
    await admin.commit({
      opId: key(),
      changes: [
        {
          op: 'patch',
          path: '/sys/limits',
          ops: { $set: { readNodes: 20, readBytes: 128 * 1024 } },
        },
      ],
    }).outcome;
    const before = (await admin.read({ node: '/records/n0' })).copies[0];
    assert.ok('node' in before);
    await first.close();
    await delivery;

    const { firstAdmin, ...reopen } = config;
    for (const rootExternal of [undefined, 'trusted'] as const) {
      const second = await openNativeRuntime({ ...reopen, rootExternal });
      t.after(() => second.close());
      assert.equal(second.instance.limits().readNodes, 20);
      assert.equal(second.instance.limits().readBytes, 128 * 1024);
      const reader = await second.instance.openSession(credential);
      const after = (await reader.read({ node: '/records/n0' })).copies[0];
      assert.ok('node' in after);
      assert.equal(after.node.$id, before.node.$id);
      assert.equal(after.node.$rev, before.node.$rev);
      assert.equal(after.node.payload, payload);
      await assert.rejects(
        reader.read({ children: '/records' }),
        (error) => error instanceof KernelError && error.code === 'BUDGET',
      );
      await second.close();
    }
  },
);
