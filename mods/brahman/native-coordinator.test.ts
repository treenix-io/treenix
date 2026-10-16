import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { createTestInstance } from '@treenx/core/kernel/testing';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import type { ModuleManifest } from '@treenx/core/kernel/types';
import { NativeConversation } from '#brahman/native-coordinator';
import { nativeNode } from '#brahman/native-state';

it(
  'conversation completes streamed actions and propagates failures after committed progress',
  { timeout: 3000 },
  async (t) => {
    const manifest: ModuleManifest = {
      id: 'conversation-fixture',
      open: [],
      security: [],
      types: [
        {
          name: 'conversation-fixture.step',
          module: 'conversation-fixture',
          security: 'ordinary',
          version: 0,
          schema: { type: 'object' },
          actions: {
            run: {
              kind: 'write',
              args: { type: 'object' },
              async *handler(ctx) {
                ctx.change.patch(ctx.node.$path, { $set: { phase: 'saved' } });
                yield { status: 'saved' };
                assert.equal((await nativeNode(ctx.read, ctx.node.$path)).phase, 'saved');
                ctx.change.patch(ctx.node.$path, { $set: { phase: 'completed' } });
                return { stop: true };
              },
            },
            fail: {
              kind: 'write',
              args: { type: 'object' },
              async *handler(ctx) {
                ctx.change.patch(ctx.node.$path, { $set: { phase: 'saved-before-error' } });
                yield { status: 'saved' };
                throw new KernelError('UNAVAILABLE', 'External operation failed');
              },
            },
          },
        },
      ],
    };
    const fixture = await createTestInstance({
      modules: [manifest],
      actors: {},
      seed: [{ $path: '/step', $type: 'conversation-fixture.step', phase: 'new' }],
    });
    const session = await fixture.instance.openSession(fixture.instance.setupCredential);
    const delivery = drainSession(session);
    t.after(async () => {
      session.close();
      await delivery;
      await fixture.close();
    });
    const conversation = new NativeConversation(session, () => ({
      epoch: fixture.instance.writer.intake.epoch,
      time: Date.now(),
      nonce: randomUUID(),
    }));
    assert.deepEqual(await conversation.act('/step', 'run', {}), { stop: true });
    assert.equal((await nativeNode(session, '/step')).phase, 'completed');
    await assert.rejects(
      () => conversation.act('/step', 'fail', {}),
      (error) => error instanceof KernelError && error.code === 'UNAVAILABLE',
    );
    assert.equal((await nativeNode(session, '/step')).phase, 'saved-before-error');
    assert.deepEqual(await conversation.act('/step', 'run', {}), { stop: true });
  },
);
