import { createNode } from '#core';
import { KernelError } from '#errors';
import { type NodeEvent, withSubscriptions } from '#sub';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commit, mutationLock, withCommitEnvelope } from './commit';

describe('commit envelope (core-gk8.15)', () => {
  it('N=1 dispatches tree.patch and applies', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', { n: 1 }));

    await commit(tree, '/a', [{ path: '/a', ops: [['r', 'n', 2]] }]);

    assert.equal((await tree.get('/a'))?.n, 2);
  });

  it('N=1 maps a failing test op to CONFLICT', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', { n: 1 }));

    await assert.rejects(
      () => commit(tree, '/a', [{ path: '/a', ops: [['t', '$rev', 999], ['r', 'n', 2]] }]),
      (e: unknown) => e instanceof KernelError && e.code === 'CONFLICT',
    );
    assert.equal((await tree.get('/a'))?.n, 1, 'nothing applied');
  });

  it('N>1 dispatches patchMany: all-or-nothing', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/x/a', 'doc', { n: 1 }));
    await tree.set(createNode('/x/b', 'doc', { n: 1 }));

    await commit(tree, '/x', [
      { path: '/x/a', ops: [['r', 'n', 2]] },
      { path: '/x/b', ops: [['r', 'n', 2]] },
    ]);
    assert.equal((await tree.get('/x/a'))?.n, 2);
    assert.equal((await tree.get('/x/b'))?.n, 2);

    await assert.rejects(
      () => commit(tree, '/x', [
        { path: '/x/a', ops: [['r', 'n', 3]] },
        { path: '/x/b', ops: [['t', '$rev', 999], ['r', 'n', 3]] },
      ]),
      (e: unknown) => e instanceof KernelError && e.code === 'CONFLICT',
    );
    assert.equal((await tree.get('/x/a'))?.n, 2, 'member #1 untouched after batch denial');
  });

  it('N>1 without patchMany capability rejects INVALID', async () => {
    const mem = createMemoryTree();
    await mem.set(createNode('/x/a', 'doc', {}));
    const { patchMany, ...noBatch } = mem;

    await assert.rejects(
      () => commit(noBatch, '/x', [
        { path: '/x/a', ops: [['r', 'n', 1]] },
        { path: '/x/b', ops: [['r', 'n', 1]] },
      ]),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('empty batch rejects INVALID', async () => {
    await assert.rejects(
      () => commit(createMemoryTree(), '/x', []),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('reentrant: commit inside an enclosing mutationLock span does not deadlock', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'doc', { n: 1 }));

    await mutationLock('/a', async () => {
      await commit(tree, '/a', [{ path: '/a', ops: [['r', 'n', 2]] }]);
    });

    assert.equal((await tree.get('/a'))?.n, 2);
  });

  it('concurrent overlapping batches both complete (sorted acquisition, no deadlock)', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/x/a', 'doc', { n: 0 }));
    await tree.set(createNode('/x/b', 'doc', { n: 0 }));

    // Opposite entry orders — internal sort makes lock order identical.
    await Promise.all([
      commit(tree, '/x', [
        { path: '/x/a', ops: [['r', 'n', 1]] },
        { path: '/x/b', ops: [['r', 'n', 1]] },
      ]),
      commit(tree, '/x', [
        { path: '/x/b', ops: [['r', 'm', 1]] },
        { path: '/x/a', ops: [['r', 'm', 1]] },
      ]),
    ]);

    const a = await tree.get('/x/a');
    const b = await tree.get('/x/b');
    assert.equal(a?.n, 1); assert.equal(a?.m, 1);
    assert.equal(b?.n, 1); assert.equal(b?.m, 1);
  });
});

// ── withCommitEnvelope (core-anz4.4): every mutation verb serializes through
// the shared mutationLock — no second write lands inside another write's span
// (sub write→reread, audit before/after, trash copy→remove). ──

/** The v-state a sub event reports: set → node body, patch → last op on `v`. */
function stateOf(e: NodeEvent): unknown {
  if (e.type === 'set') return (e.node as Record<string, unknown>).v;
  if (e.type === 'patch') return [...e.patches].reverse().find(o => o[1] === 'v')?.[2];
  return undefined;
}

describe('withCommitEnvelope (core-anz4.4)', () => {
  it('sub events carry their own write state and opId under concurrent same-path writes', async () => {
    const events: NodeEvent[] = [];
    const { tree: subbed } = withSubscriptions(createMemoryTree(), e => events.push(e));
    const tree = withCommitEnvelope(subbed);

    // Unlocked, the sub wrapper's write→stored-reread window lets write B land
    // between A's inner set and A's reread — A's event then carries B's state
    // with A's opId, poisoning replay/ack/audit causality.
    await Promise.all([
      tree.set(createNode('/n', 'dir', { v: 1 }), { opId: 'a' }),
      tree.set(createNode('/n', 'dir', { v: 2 }), { opId: 'b' }),
    ]);

    assert.equal(events.length, 2);
    const a = events.find(e => 'by' in e && e.by === 'a');
    const b = events.find(e => 'by' in e && e.by === 'b');
    assert.ok(a && b, 'both writes emitted under their own opId');
    assert.equal(stateOf(a), 1, "a's event reflects a's write, not the concurrent one");
    assert.equal(stateOf(b), 2);
  });

  it('a multi-step remove span excludes a concurrent set on the same path', async () => {
    const log: string[] = [];
    const mem = createMemoryTree();
    await mem.set(createNode('/x', 'dir', { v: 1 }));

    // Trash-like remove below the envelope: read → copy → remove, with awaits
    // a concurrent writer could previously interleave into.
    const inner: Tree = {
      ...mem,
      async remove(path, ctx) {
        log.push('remove:start');
        await mem.get(path);
        await mem.set(createNode('/trash-copy', 'dir', {}));
        log.push('remove:end');
        return mem.remove(path, ctx);
      },
      async set(node, ctx) {
        log.push(`set:${node.$path}`);
        return mem.set(node, ctx);
      },
    };
    const tree = withCommitEnvelope(inner);

    await Promise.all([
      tree.remove('/x'),
      tree.set(createNode('/x', 'dir', { v: 2 })),
    ]);

    assert.ok(log.indexOf('set:/x') > log.indexOf('remove:end'), 'set waited for the whole remove span');
    assert.equal((await mem.get('/x'))?.v, 2, 'set landed after the remove, not inside it');
  });

  it('patchMany holds all member locks — a direct set on a member waits', async () => {
    const log: string[] = [];
    const mem = createMemoryTree();
    await mem.set(createNode('/p', 'dir', {}));
    await mem.set(createNode('/p/a', 'dir', { v: 0 }));
    await mem.set(createNode('/p/b', 'dir', { v: 0 }));

    // Signals that the batch span is entered — every member lock is held.
    let entered!: () => void;
    const inBatch = new Promise<void>(r => { entered = r; });

    const inner: Tree = {
      ...mem,
      async patchMany(ancestor, entries, ctx) {
        log.push('pm:start');
        entered();
        await mem.get(entries[0].path); // yield inside the batch span
        const receipt = await mem.patchMany!(ancestor, entries, ctx);
        log.push('pm:end');
        return receipt;
      },
      async set(node, ctx) {
        log.push(`set:${node.$path}`);
        return mem.set(node, ctx);
      },
    };
    const tree = withCommitEnvelope(inner);

    const pm = tree.patchMany!('/p', [
      { path: '/p/a', ops: [['r', 'v', 1]] },
      { path: '/p/b', ops: [['r', 'v', 1]] },
    ]);
    await inBatch;
    const setP = tree.set(createNode('/p/b', 'dir', { v: 9 }));
    await Promise.all([pm, setP]);

    assert.ok(log.indexOf('set:/p/b') > log.indexOf('pm:end'), 'member set waited for the batch');
    assert.equal((await mem.get('/p/b'))?.v, 9, 'set applied after the batch');
  });

  it('writes to different paths do not serialize', async () => {
    const log: string[] = [];
    const mem = createMemoryTree();

    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inner: Tree = {
      ...mem,
      async set(node, ctx) {
        if (node.$path === '/slow') await gate;
        log.push(`set:${node.$path}`);
        return mem.set(node, ctx);
      },
    };
    const tree = withCommitEnvelope(inner);

    const slow = tree.set(createNode('/slow', 'dir', {}));
    await tree.set(createNode('/fast', 'dir', {}));
    assert.deepEqual(log, ['set:/fast'], 'a parked write on one path never blocks another path');

    release();
    await slow;
    assert.deepEqual(log, ['set:/fast', 'set:/slow']);
  });

  it('a listener-spawned same-path write queues behind the emitting span (no inherited lock)', async () => {
    const log: string[] = [];
    const mem = createMemoryTree();
    await mem.set(createNode('/n', 'dir', { v: 0 }));

    const inner: Tree = {
      ...mem,
      async set(node, ctx) {
        log.push(`w:${node.v}`);
        return mem.set(node, ctx);
      },
    };

    let listenerWrite: Promise<unknown> | undefined;
    let treeRef!: Tree;
    const { tree: subbed } = withSubscriptions(inner, () => {
      // Fire-and-forget async work spawned synchronously inside dispatch —
      // the exact shape that used to inherit the span's lock ownership.
      if (!listenerWrite) listenerWrite = treeRef.set(createNode('/n', 'dir', { v: 99 }));
    }, { detachLocks: mutationLock.detach });

    // Park the emitting span AFTER dispatch, so the lock is provably still held.
    let tailReached!: () => void;
    const tail = new Promise<void>(r => { tailReached = r; });
    let releaseTail!: () => void;
    const tailGate = new Promise<void>(r => { releaseTail = r; });
    const parked: Tree = {
      ...subbed,
      async set(node, ctx) {
        const receipt = await subbed.set(node, ctx);
        if (node.v === 1) { tailReached(); await tailGate; }
        return receipt;
      },
    };
    treeRef = withCommitEnvelope(parked);

    const cause = treeRef.set(createNode('/n', 'dir', { v: 1 }));
    await tail;
    for (let i = 0; i < 50; i++) await Promise.resolve(); // drain microtasks
    assert.ok(!log.includes('w:99'), 'listener write parked outside the span, not falsely inline');

    releaseTail();
    await cause;
    await listenerWrite;
    assert.equal((await mem.get('/n'))?.v, 99, 'listener write landed after the span');
  });

  it('cross-path waits fail loud instead of deadlocking (AB-BA)', async () => {
    const mem = createMemoryTree();
    await mem.set(createNode('/a', 'dir', {}));
    await mem.set(createNode('/b', 'dir', {}));
    const tree = withCommitEnvelope(mem);

    let enterA!: () => void, enterB!: () => void;
    const bothIn = Promise.all([
      new Promise<void>(r => { enterA = r; }),
      new Promise<void>(r => { enterB = r; }),
    ]);

    // Action-span shape on both sides, writing each other's path.
    const spanA = mutationLock('/a', async () => {
      enterA(); await bothIn;
      await tree.set(createNode('/b', 'dir', { from: 'A' })); // ascending: waits
    });
    const spanB = mutationLock('/b', async () => {
      enterB(); await bothIn;
      await tree.set(createNode('/a', 'dir', { from: 'B' })); // descending + contended: fails loud
    });

    const [ra, rb] = await Promise.allSettled([spanA, spanB]);
    assert.equal(ra.status, 'fulfilled', 'ascending waiter completes');
    assert.ok(rb.status === 'rejected' && rb.reason instanceof KernelError && rb.reason.code === 'CONFLICT',
      'descending contender rejects CONFLICT instead of deadlocking');
    assert.equal((await mem.get('/b'))?.from, 'A');
  });

  it('a descending acquire on a FREE path proceeds', async () => {
    const mem = createMemoryTree();
    await mem.set(createNode('/a', 'dir', {}));
    const tree = withCommitEnvelope(mem);

    await mutationLock('/b', () => tree.set(createNode('/a', 'dir', { v: 7 })));
    assert.equal((await mem.get('/a'))?.v, 7);
  });

  it('a chain outliving its span loses lock ownership — no stale reentrancy', async () => {
    const log: string[] = [];
    const mem = createMemoryTree();
    await mem.set(createNode('/x', 'dir', { v: 0 }));
    const inner: Tree = {
      ...mem,
      async set(node, ctx) {
        log.push(`w:${node.v}`);
        return mem.set(node, ctx);
      },
    };
    const tree = withCommitEnvelope(inner);

    let escape!: () => void;
    const escaped = new Promise<void>(r => { escape = r; });
    let zombie: Promise<void> | undefined;
    await mutationLock('/x', async () => {
      // Continuation escaping its span — carries the stale ALS ownership
      // (the timed-out-action shape).
      zombie = (async () => { await escaped; await tree.set(createNode('/x', 'dir', { v: 9 })); })();
    });

    // New owner takes /x and parks; the zombie wakes DURING its span.
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>(r => { releaseOwner = r; });
    let ownerIn!: () => void;
    const ownerEntered = new Promise<void>(r => { ownerIn = r; });
    const owner = mutationLock('/x', async () => {
      ownerIn(); escape(); await ownerGate; log.push('owner:end');
    });

    await ownerEntered;
    for (let i = 0; i < 50; i++) await Promise.resolve(); // drain microtasks
    assert.ok(!log.includes('w:9'), 'stale chain queues instead of running inline over the new owner');

    releaseOwner();
    await owner;
    await zombie;
    assert.ok(log.indexOf('w:9') > log.indexOf('owner:end'), 'stale write serialized after the live owner');
  });

  it('re-acquiring inside an enclosing span is reentrant — no self-deadlock', async () => {
    const mem = createMemoryTree();
    await mem.set(createNode('/p', 'dir', {}));
    await mem.set(createNode('/p/a', 'dir', { v: 0 }));
    await mem.set(createNode('/p/b', 'dir', { v: 0 }));
    const tree = withCommitEnvelope(mem);

    // Action-span shape: the span holds the path, the inner verb re-acquires it.
    await mutationLock('/p/a', () => tree.set(createNode('/p/a', 'dir', { v: 3 })));
    assert.equal((await mem.get('/p/a'))?.v, 3);

    // Batch sharing the span path.
    await mutationLock('/p/a', () => tree.patchMany!('/p', [
      { path: '/p/a', ops: [['r', 'v', 4]] },
      { path: '/p/b', ops: [['r', 'v', 4]] },
    ]));
    assert.equal((await mem.get('/p/a'))?.v, 4);
    assert.equal((await mem.get('/p/b'))?.v, 4);
  });
});
