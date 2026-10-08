import { createNode, register, R, W } from '#core';
import { KernelError } from '#errors';
import type { ResFrame } from '#protocol/frames';
import { createWatchManager } from '#sub/watch';
import { clearRegistry } from '#testing';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import type { ActionCtx } from './actions';
import { createWireSession, type SessionExecutor } from './wire';

beforeEach(clearRegistry);

async function fixture() {
  const tree = createMemoryTree();
  await tree.set({ ...createNode('/', 'dir'), $acl: [{ g: 'agent', p: R | W }] });
  await tree.set(createNode('/private', 'dir'));
  await tree.set(createNode('/private/action', 'test.workload.stream'));
  await tree.set(createNode('/private/effect', 'dir', { value: 0 }));
  register('test.workload.stream', 'schema', () => ({
    type: 'object', properties: {}, methods: { run: { arguments: [], streaming: true } },
  }));
  let effects = 0;
  register('test.workload.stream', 'action:run', async function* (ctx: ActionCtx) {
    effects++;
    await ctx.tree.patch('/private/effect', [['r', 'value', 1]]);
    yield 'changed';
  });
  let dispatched = 0;
  const executor: SessionExecutor = async () => {
    dispatched++;
    throw new KernelError('FORBIDDEN', 'Action is outside workload scope');
  };
  return {
    deps: { tree, systemTree: tree, watcher: createWatchManager(), opts: { executor } },
    tree, effects: () => effects, dispatched: () => dispatched,
  };
}

it('workload streams deny before running a handler outside the executor scope', async () => {
  const f = await fixture();
  const wire = createWireSession(f.deps, { userId: 'agent', claims: ['agent'], scopeRef: '/scope' });
  const unary = await wire.handle({ id: 1, op: 'act', path: '/private/action', action: 'run' });
  assert.ok('err' in unary);
  assert.equal(unary.err.code, 'FORBIDDEN');
  assert.equal(f.dispatched(), 1);

  const stream = wire.handle({ id: 2, op: 'act', stream: true, path: '/private/action', action: 'run' });
  assert.ok(Symbol.asyncIterator in stream);
  const frames: ResFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  assert.equal(frames.length, 1);
  assert.ok('err' in frames[0]);
  assert.equal(frames[0].err.code, 'FORBIDDEN');
  assert.equal(f.effects(), 0);
  assert.equal((await f.tree.get('/private/effect'))?.value, 0);
});

it('ordinary sessions retain streaming when a workload executor is configured', async () => {
  const f = await fixture();
  const wire = createWireSession(f.deps, { userId: 'agent', claims: ['agent'] });
  const stream = wire.handle({ id: 3, op: 'act', stream: true, path: '/private/action', action: 'run' });
  assert.ok(Symbol.asyncIterator in stream);
  const frames: ResFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  assert.deepEqual(frames, [{ id: 3, ch: 'changed' }, { id: 3, end: true }]);
  assert.equal(f.dispatched(), 0);
  assert.equal(f.effects(), 1);
  assert.equal((await f.tree.get('/private/effect'))?.value, 1);
});
