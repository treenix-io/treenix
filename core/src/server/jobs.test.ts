// startJob — detached job context (core-gk8.5).
// Envelope escape, kind gate, budget signal, never-reject, registry drain.

import { createNode, type NodeData, register } from '#core';
import { clearRegistry } from '#testing';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type ActionCtx, executeAction } from './actions';
import { mutationLock } from './commit';
import { drainJobs, type JobHandle, runningJobs, startJob } from './jobs';

describe('startJob', () => {
  beforeEach(() => clearRegistry());
  afterEach(() => drainJobs());

  it('escapes the action envelope: spawner returns, job then executes on the very path the spawner locked', async () => {
    register('test.job.host', 'schema', () => ({
      $id: 'test.job.host', title: 'Host', type: 'object' as const,
      properties: { n: { type: 'number' } },
      methods: { spawn: { arguments: [] }, bump: { arguments: [] } },
    }));
    register('test.job.host', 'action:bump', async (ctx: ActionCtx) => {
      (ctx.node as NodeData & { n: number }).n += 1;
    });
    let handle: JobHandle | undefined;
    register('test.job.host', 'action:spawn', async (ctx: ActionCtx) => {
      const tree = ctx.tree;
      handle = startJob('test-job', async () => {
        // Same path the spawning action holds the lock on — the detached job
        // QUEUES on the released lock instead of deadlocking inside it.
        await executeAction(tree, '/h', undefined, undefined, 'bump');
      });
      return 'spawned';
    });
    const tree = createMemoryTree();
    await tree.set(createNode('/h', 'test.job.host', { n: 0 }));

    const res = await executeAction(tree, '/h', undefined, undefined, 'spawn');

    assert.equal(res, 'spawned');
    assert.ok(handle, 'job spawned');
    const r = await handle.done;
    assert.equal(r.ok, true);
    const node = await tree.get('/h') as NodeData & { n: number };
    assert.equal(node.n, 1, 'job mutation landed after the spawner released the lock');
  });

  it('detached job genuinely CONTENDS for a path lock the spawner holds — no ALS-inherited reentry (core-anz4.21)', async () => {
    const log: string[] = [];
    let handle: JobHandle | undefined;
    register('test.job.contend', 'schema', () => ({
      $id: 'test.job.contend', title: 'Contend', type: 'object' as const,
      properties: {}, methods: { go: { arguments: [] } },
    }));
    register('test.job.contend', 'action:go', async () => {
      // The whole handler runs inside lockAction('/c') — '/c' is in the held
      // set. A reentrant job would acquire the SAME lock inline (bug); a
      // detached job must queue behind the still-held gate.
      log.push('span:start');
      handle = startJob('contend-job', async () => {
        await mutationLock('/c', async () => { log.push('job:acquired'); });
      });
      log.push('span:end');
    });
    const tree = createMemoryTree();
    await tree.set(createNode('/c', 'test.job.contend'));

    await executeAction(tree, '/c', undefined, undefined, 'go');
    assert.ok(handle, 'job spawned');
    await handle.done;

    assert.ok(log.includes('job:acquired'), 'job acquired the lock');
    assert.ok(
      log.indexOf('span:end') < log.indexOf('job:acquired'),
      'job acquired the lock only AFTER the action span released it (contended, did not reenter)',
    );
  });

  it('read action cannot detach a job (FORBIDDEN, fail closed)', async () => {
    register('test.job.reader', 'schema', () => ({
      $id: 'test.job.reader', title: 'Reader', type: 'object' as const,
      properties: {},
      methods: { peek: { arguments: [], kind: 'read' as const } },
    }));
    register('test.job.reader', 'action:peek', async () => {
      startJob('laundered-write', async () => { /* must never run */ });
    });
    const tree = createMemoryTree();
    await tree.set(createNode('/r', 'test.job.reader'));

    await assert.rejects(
      () => executeAction(tree, '/r', undefined, undefined, 'peek'),
      (e: { code?: string }) => e.code === 'FORBIDDEN',
    );
    assert.equal(runningJobs().length, 0, 'nothing was detached');
  });

  it('budget elapses → body sees the aborted signal', async () => {
    const { signal, done } = startJob('budget', (sig) => new Promise<void>((resolve) => {
      sig.addEventListener('abort', () => resolve(), { once: true });
    }), { timeoutMs: 20 });

    const r = await done;

    assert.equal(r.ok, true, 'body chose to resolve on abort');
    assert.equal(signal.aborted, true);
  });

  it('throwing body: done resolves {ok:false, error} — never rejects', async () => {
    const { done } = startJob('boom', async () => { throw new Error('kaput'); });

    const r = await done;

    assert.equal(r.ok, false);
    assert.ok(r.error instanceof Error);
  });

  it('registry tracks in-flight jobs and drainJobs drains them', async () => {
    let release: (() => void) | undefined;
    startJob('tracked', () => new Promise<void>((resolve) => { release = resolve; }));

    assert.equal(runningJobs().length, 1);
    assert.equal(runningJobs()[0].label, 'tracked');
    assert.ok(runningJobs()[0].startedAt > 0);

    release!();
    await drainJobs();
    assert.equal(runningJobs().length, 0);
  });
});
