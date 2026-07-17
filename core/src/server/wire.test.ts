// Wire session over a real MessageChannel — the postMessage host path end-to-end:
// createWireSession + attachWireSession on port1, createClient on port2.
// Covers: ACL fail-closed over the wire, watch registration + filtered event
// delivery, VP deltas → dirty frames, reset verdict, watch release (m77).

import { createClient } from '#client/wire';
import { createNode, R, S, W } from '#core';
import { OpError } from '#errors';
import { createPortConn } from '#protocol/port';
import type { Session } from '#security/sessions';
import { withSubscriptions } from '#sub';
import { createWatchManager } from '#sub/watch';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { describe, it } from 'node:test';
import { attachWireSession, createWireSession, toEventFrames, type WireDeps } from './wire';

async function harness(perm: number, ringSize?: number) {
  const memory = createMemoryTree();
  await memory.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: perm }] });
  await memory.set(createNode('/doc', 'dir', { title: 'doc' }));
  // filterPatches fails closed for ops on fields absent from the stored node —
  // tests must patch EXISTING fields or the event is (correctly) dropped.
  await memory.set(createNode('/barrier', 'dir', { n: 0 }));

  const watcher = createWatchManager(ringSize ? { ringSize } : undefined);
  // Real pipeline shape: writes emit events → watcher routes → filtered push.
  const { tree } = withSubscriptions(memory, (e) => watcher.notify(e));
  const deps: WireDeps = { tree, systemTree: memory, watcher };
  const session: Session = { userId: 'wire-anon', anonymous: true, claims: ['public'] };
  const wire = createWireSession(deps, session);

  function dial(since?: number) {
    const { port1, port2 } = new MessageChannel();
    const teardown = attachWireSession(wire, createPortConn(port1), since);
    const client = createClient(createPortConn(port2));
    return { client, teardown };
  }

  const first = dial();
  return { tree: tree as Tree, watcher, wire, dial, client: first.client, teardown: first.teardown };
}

const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

describe('wire session over MessageChannel', () => {
  it('reads pass, writes FORBIDDEN for read-only session — ACL fail closed over postMessage', async (t) => {
    const { client } = await harness(R | S);
    t.after(() => client.destroy());
    const doc = await client.tree.get('/doc');
    assert.equal(doc?.title, 'doc');
    await assert.rejects(client.tree.set({ $path: '/doc', $type: 'dir', title: 'hack' }), isCode('FORBIDDEN'));
  });

  it('emits reset on fresh connect; watched events arrive as seq-stamped frames; vps map to dirty', async (t) => {
    const { watcher, client } = await harness(R | S);
    t.after(() => client.destroy());

    // Frames of one NodeEvent cross the port as separate tasks — wait for the
    // LAST frame of the batch (2nd dirty), then assert the whole sequence.
    const frames: { ev?: string; path?: string }[] = [];
    let batchDone!: () => void;
    const batch = new Promise<void>((r) => { batchDone = r; });
    client.watch((e: { ev?: string }) => {
      frames.push(e);
      if (frames.filter((f) => f.ev === 'dirty').length === 2) batchDone();
    });

    const sub = await client.watchPath('/doc', () => {});
    // dirty frames only for vps THIS session registered — invalidateVps is
    // narrowed per user at the WatchManager (core-cnr.8 C26).
    watcher.watch('wire-anon', ['/views/all', '/views/inbox'], { children: true });

    watcher.notify({
      type: 'patch', path: '/doc', patches: [['r', 'title', 'doc2']],
      invalidateVps: ['/views/all', '/views/inbox'],
    });
    await batch;

    assert.deepEqual(frames[0], { ev: 'reset', reason: 'resume' }); // fresh connect → continuity verdict
    const patch = frames.find((f) => f.ev === 'patch');
    assert.deepEqual(patch, { seq: 1, ev: 'patch', path: '/doc', ops: [['r', 'title', 'doc2']] });
    const dirty = frames.filter((f) => f.ev === 'dirty');
    assert.deepEqual(dirty.map((d) => d.path).sort(), ['/views/all', '/views/inbox']);

    sub.unsubscribe();
  });

  it('watchPath release stops delivery — server watch gone (m77 over the wire)', async (t) => {
    const { watcher, client } = await harness(R | S);
    t.after(() => client.destroy());

    const docEvents: unknown[] = [];
    const docSub = await client.watchPath('/doc', (e) => docEvents.push(e));
    let hitBarrier!: () => void;
    const barrierHit = new Promise<void>((r) => { hitBarrier = r; });
    await client.watchPath('/barrier', () => hitBarrier());

    docSub.unsubscribe();
    await new Promise<void>((r) => setImmediate(r)); // unsub frame crosses the port

    watcher.notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'late']] });
    watcher.notify({ type: 'patch', path: '/barrier', patches: [['r', 'n', 1]] });

    // Per-session delivery is ordered: once the barrier event landed, the /doc
    // event would already have arrived — its absence proves the watch is gone.
    await barrierHit;
    assert.deepEqual(docEvents, []);
  });

  it('write-enabled session mutates through the full stack', async (t) => {
    const { tree, client } = await harness(R | W | S);
    t.after(() => client.destroy());
    await client.tree.patch('/doc', [['r', 'title', 'patched']]);
    const doc = await tree.get('/doc');
    assert.equal(doc?.title, 'patched');
  });

  it('mutation opId echoes as by; seq stamps frames end-to-end (gk8.1)', async (t) => {
    const { client } = await harness(R | W | S);
    t.after(() => client.destroy());

    const got: { ev?: string; by?: string; seq?: number }[] = [];
    let patched!: () => void;
    const done = new Promise<void>((r) => { patched = r; });
    await client.watchPath('/doc', (e: { ev?: string; by?: string; seq?: number }) => {
      got.push(e);
      if (e.ev === 'patch') patched();
    });

    await client.peer.req.patch('/doc', [['r', 'title', 'x']], 'op-42');
    await done;

    const frame = got.find((f) => f.ev === 'patch');
    assert.equal(frame?.by, 'op-42');
    assert.equal(frame?.seq, 1);
  });

  it('resume: bare-number since fails closed — reset frame, never a stale replay (anz4.10)', async (t) => {
    // attachWireSession still passes a number-only `since`; an epoch-less
    // cursor cannot prove it belongs to the live seq space, so the verdict is
    // a reset and the ring is NOT replayed. Covered resume (seq + epoch) is
    // exercised at the WatchManager contract level until the binding threads
    // the epoch through hi{since,epoch}.
    const { tree, client, teardown, dial } = await harness(R | W | S, 8);

    let firstEv!: () => void;
    const first = new Promise<void>((r) => { firstEv = r; });
    const seen: { seq?: number }[] = [];
    await client.watchPath('/doc', (e: { seq?: number }) => { seen.push(e); firstEv(); });
    await tree.patch('/doc', [['r', 'title', 'v1']]); // seq 1 — live
    await first;
    assert.equal(seen[0]?.seq, 1);

    teardown();
    client.destroy(); // watch-sets survive in grace; events below land in the ring
    await tree.patch('/doc', [['r', 'title', 'v2']]); // seq 2
    await tree.patch('/doc', [['r', 'title', 'v3']]); // seq 3

    const b = dial(1);
    t.after(() => b.client.destroy());
    const frames: { ev?: string }[] = [];
    let gotReset!: () => void;
    const reset = new Promise<void>((r) => { gotReset = r; });
    b.client.watch((e: { ev?: string }) => {
      frames.push(e);
      if (e.ev === 'reset') gotReset();
    });
    await reset;
    await new Promise<void>((r) => setImmediate(r)); // drain anything queued behind it

    assert.deepEqual(frames, [{ ev: 'reset', reason: 'resume' }]);
  });

  it('stale cursor → reset frame, never a partial replay (gk8.1)', async (t) => {
    const { tree, client, teardown, dial } = await harness(R | W | S, 1); // ring of 1
    await client.watchPath('/doc', () => {});
    teardown();
    client.destroy();
    await tree.patch('/doc', [['r', 'title', 'v1']]);
    await tree.patch('/doc', [['r', 'title', 'v2']]);
    await tree.patch('/doc', [['r', 'title', 'v3']]); // ring holds only seq 3

    const b = dial(0); // cursor far behind the ring
    t.after(() => b.client.destroy());
    const frames: { ev?: string }[] = [];
    let gotReset!: () => void;
    const reset = new Promise<void>((r) => { gotReset = r; });
    b.client.watch((e: { ev?: string }) => {
      frames.push(e);
      if (e.ev === 'reset') gotReset();
    });
    await reset;
    await new Promise<void>((r) => setImmediate(r)); // drain anything queued behind it

    assert.deepEqual(frames, [{ ev: 'reset', reason: 'resume' }]);
  });
});

describe('toEventFrames — pathless invalidate (core-dm1)', () => {
  it('one dirty frame per view, seq carried, no data facet', () => {
    const frames = toEventFrames({ type: 'invalidate', vps: ['/views/a', '/views/b'], seq: 9 });
    assert.deepEqual(frames, [
      { seq: 9, ev: 'dirty', path: '/views/a' },
      { seq: 9, ev: 'dirty', path: '/views/b' },
    ]);
  });

  it('omits seq when unstamped (wire parity across transports)', () => {
    const frames = toEventFrames({ type: 'invalidate', vps: ['/views/a'] });
    assert.deepEqual(frames, [{ ev: 'dirty', path: '/views/a' }]);
  });
});
