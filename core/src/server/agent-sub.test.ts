// Focused reproduction test: new child created via action → watcher notifies
// Tests the exact agent scenario: action:task creates /agent/tasks/t-xxx,
// user watching /agent/tasks prefix should get the event.

import { createNode, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type ActionCtx, executeAction } from './actions';
import { type NodeEvent, withSubscriptions } from './sub';
import { createWatchManager } from './watch';

describe('Agent task subscription', () => {
  beforeEach(() => clearRegistry());

  it('new child created via action triggers prefix watcher', async () => {
    // Register the action (simulates agent's action:task)
    register('agent.config', 'action:task', async (ctx: ActionCtx, data: { prompt: string }) => {
      const id = `t-${Date.now()}`;
      const taskPath = `${ctx.node.$path}/tasks/${id}`;
      await ctx.store.set(createNode(taskPath, 'agent.task', {
        prompt: data.prompt,
        status: 'pending',
        createdAt: Date.now(),
      }));
      return { taskPath };
    });

    // Build store pipeline: memory → subscriptions → watcher
    const mem = createMemoryTree();
    const watcher = createWatchManager();
    const store = withSubscriptions(mem, (e) => watcher.notify(e));

    // Seed the agent config node
    await store.set(createNode('/agent', 'agent.config', { systemPrompt: 'test' }));
    await store.set(createNode('/agent/tasks', 'dir'));

    // Simulate user: connect SSE + register prefix watch
    const events: NodeEvent[] = [];
    watcher.connect('conn1', 'user1', (e) => events.push(e));
    watcher.watch('user1', ['/agent/tasks'], { children: true, autoWatch: true });

    // Execute the action (same as trpc.execute.mutate)
    const result = await executeAction(store, '/agent', undefined, undefined, 'task', { prompt: 'test task' });
    assert.ok(result && typeof (result as any).taskPath === 'string');

    // Verify: the watcher should have received the new task event
    assert.equal(events.length, 1, 'watcher should have received exactly 1 event');
    assert.equal(events[0].type, 'set', 'event should be of type "set"');
    assert.ok((events[0] as any).path.startsWith('/agent/tasks/t-'), 'event path should be the new task');
    assert.equal((events[0] as any).node.$type, 'agent.task', 'node should have correct $type');
  });

  it('new child event includes correct node data for cache.put', async () => {
    register('agent.config', 'action:task', async (ctx: ActionCtx, data: { prompt: string }) => {
      const taskPath = `${ctx.node.$path}/tasks/t-1`;
      await ctx.store.set(createNode(taskPath, 'agent.task', {
        prompt: data.prompt,
        status: 'pending',
        createdAt: 12345,
      }));
      return { taskPath };
    });

    const mem = createMemoryTree();
    const watcher = createWatchManager();
    const store = withSubscriptions(mem, (e) => watcher.notify(e));

    await store.set(createNode('/agent', 'agent.config'));
    await store.set(createNode('/agent/tasks', 'dir'));

    const events: NodeEvent[] = [];
    watcher.connect('c1', 'u1', (e) => events.push(e));
    watcher.watch('u1', ['/agent/tasks'], { children: true, autoWatch: true });

    await executeAction(store, '/agent', undefined, undefined, 'task', { prompt: 'hello' });

    // Simulate what the client does: reconstruct the node from the event
    assert.equal(events.length, 1);
    const evt = events[0] as { type: 'set'; path: string; node: any };
    const reconstructed = { $path: evt.path, ...evt.node };

    assert.equal(reconstructed.$path, '/agent/tasks/t-1');
    assert.equal(reconstructed.$type, 'agent.task');
    assert.equal(reconstructed.prompt, 'hello');
    assert.equal(reconstructed.status, 'pending');
    assert.equal(reconstructed.createdAt, 12345);
  });
});
