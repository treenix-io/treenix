import { registerType } from '#comp';
import { createNode, register } from '#core';
import { clearRegistry } from '#testing';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { executeAction } from './actions';

// Coordination gates: slowBump signals entry, then parks until the test
// lets it finish — the window where a concurrent writer can sneak in.
let entered: () => void;
let enteredP: Promise<void>;
let release: () => void;
let releaseP: Promise<void>;

class Counter {
  count = 0;
  note = '';

  async bump() {
    this.count = this.count + 1;
  }

  async slowBump() {
    entered();
    await releaseP;
    this.count = this.count + 1;
  }
}

const counterSchema = () => ({
  $id: 'counter', title: 'Counter', type: 'object' as const,
  properties: { count: { type: 'number' }, note: { type: 'string' } },
  methods: { bump: { arguments: [] }, slowBump: { arguments: [] } },
});

describe('executeAction OCC commit', () => {
  beforeEach(() => {
    clearRegistry();
    registerType('counter', Counter);
    register('counter', 'schema', counterSchema);
    enteredP = new Promise<void>(r => { entered = r; });
    releaseP = new Promise<void>(r => { release = r; });
  });

  it('commits and bumps $rev when nothing raced', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/c', 'counter', { count: 0, note: '' }));
    const before = (await tree.get('/c'))!;

    await executeAction(tree, '/c', undefined, undefined, 'bump');

    const after = (await tree.get('/c'))!;
    assert.equal(after.count, 1);
    assert.ok((after.$rev ?? 0) > (before.$rev ?? 0));
  });

  it('rejects with CONFLICT when the node changed during the action — no silent merge', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/c', 'counter', { count: 0, note: '' }));

    const run = executeAction(tree, '/c', undefined, undefined, 'slowBump');
    await enteredP;

    // Concurrent writer bypassing the action lock (direct set, as a second
    // pipeline or a service would do): bumps $rev under the running action.
    const fresh = (await tree.get('/c'))!;
    fresh.note = 'external';
    await tree.set(fresh);

    release();
    await assert.rejects(run, (e: unknown) => (e as { code?: string }).code === 'CONFLICT');

    // The concurrent write survives untouched; the stale draft is NOT merged over it.
    const after = (await tree.get('/c'))!;
    assert.equal(after.note, 'external');
    assert.equal(after.count, 0);
  });

  it('sequential actions advance $rev without conflicts', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/c', 'counter', { count: 0, note: '' }));

    await executeAction(tree, '/c', undefined, undefined, 'bump');
    await executeAction(tree, '/c', undefined, undefined, 'bump');
    await executeAction(tree, '/c', undefined, undefined, 'bump');

    const after = (await tree.get('/c'))!;
    assert.equal(after.count, 3);
  });

  it('non-mutating action commits nothing and leaves $rev untouched', async () => {
    class Noop { async touch() { /* mutates nothing */ } }
    registerType('noop', Noop);
    register('noop', 'schema', () => ({
      $id: 'noop', title: 'Noop', type: 'object' as const,
      properties: {}, methods: { touch: { arguments: [] } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'noop'));
    const before = (await tree.get('/n'))!;

    await executeAction(tree, '/n', undefined, undefined, 'touch');

    const after = (await tree.get('/n'))!;
    assert.equal(after.$rev, before.$rev);
  });
});
