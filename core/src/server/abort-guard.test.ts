// wrapAbortGuardTree: a handler that resumes after its action timed out must not write —
// the path lock it relied on was already released (see readonly-tree.ts).

import { makeNode } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapAbortGuardTree } from './readonly-tree';

const isConflict = (e: unknown) => (e as { code?: string })?.code === 'CONFLICT';

describe('wrapAbortGuardTree', () => {
  it('forwards writes while the signal is live', async () => {
    const guarded = wrapAbortGuardTree(createMemoryTree(), new AbortController().signal);

    await guarded.set(makeNode('/a', 'dir'));
    assert.ok(await guarded.get('/a'));

    await guarded.remove('/a');
    assert.equal(await guarded.get('/a'), undefined);
  });

  it('denies every mutation verb once aborted', async () => {
    const inner = createMemoryTree();
    await inner.set(makeNode('/a', 'dir'));

    const ctl = new AbortController();
    const guarded = wrapAbortGuardTree(inner, ctl.signal);
    ctl.abort();

    // Sync throw, mirroring the read facade's deny() — an awaiting handler sees a rejection either way
    assert.throws(() => guarded.set(makeNode('/b', 'dir')), isConflict);
    assert.throws(() => guarded.patch('/a', [['a', '/x', 1]]), isConflict);
    assert.throws(() => guarded.remove('/a'), isConflict);
    if (guarded.patchMany) {
      assert.throws(() => guarded.patchMany!('/', [{ path: '/a', ops: [['a', '/x', 1]] }]), isConflict);
    }

    // the write that raced the abort never landed
    const a = await guarded.get('/a');
    assert.ok(a);
    assert.equal(a.x, undefined);
    assert.equal(await guarded.get('/b'), undefined);
  });

  it('keeps reads open so an in-flight handler can unwind', async () => {
    const inner = createMemoryTree();
    await inner.set(makeNode('/a', 'dir'));

    const ctl = new AbortController();
    const guarded = wrapAbortGuardTree(inner, ctl.signal);
    ctl.abort();

    assert.ok(await guarded.get('/a'));
    const { items } = await guarded.getChildren('/');
    assert.equal(items.length, 1);
  });

  it('does not fake optional capabilities the inner tree lacks', () => {
    const inner = createMemoryTree();
    const guarded = wrapAbortGuardTree(inner, new AbortController().signal);

    assert.equal('patchMany' in guarded, 'patchMany' in inner);
    assert.equal('execute' in guarded, 'execute' in inner);
  });
});
