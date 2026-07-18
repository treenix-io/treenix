// Wire session over a real MessageChannel — the postMessage host path end-to-end:
// createWireSession + attachWireSession on port1, createClient on port2.
// Covers: ACL fail-closed over the wire, watch registration + filtered event
// delivery, VP deltas → dirty frames, reset verdict, watch release (m77).

import { createClient } from '#client/wire';
import { createNode, R, S, W } from '#core';
import { OpError } from '#errors';
import type { ResolvedReadPlan } from '#mount/resolve-plan';
import { createPortConn } from '#protocol/port';
import type { Session } from '#security/sessions';
import { withSubscriptions, type NodeEvent } from '#sub';
import { createWatchManager, type WatchCursor } from '#sub/watch';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { describe, it } from 'node:test';
import { attachWireSession, createWireSession, registerWatchList, toEventFrames, type WireDeps } from './wire';

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

  function dial(since?: number | WatchCursor) {
    const { port1, port2 } = new MessageChannel();
    const teardown = attachWireSession(wire, createPortConn(port1), since);
    const client = createClient(createPortConn(port2));
    return { client, teardown };
  }

  const first = dial();
  return { tree: tree as Tree, memory, watcher, wire, dial, client: first.client, teardown: first.teardown };
}

/** Assert the frame is a reset stamped with a resumable cursor (anz4.28e). */
function assertStampedReset(f: { ev?: string; reason?: string; seq?: number; epoch?: string } | undefined): asserts f is { ev: 'reset'; reason: 'resume'; seq: number; epoch: string } {
  assert.equal(f?.ev, 'reset');
  assert.equal(f?.reason, 'resume');
  assert.equal(typeof f?.seq, 'number', 'reset must carry the current seq');
  assert.equal(typeof f?.epoch, 'string', 'reset must carry the stream epoch');
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

    assertStampedReset(frames[0]); // fresh connect → continuity verdict, stamped (anz4.28e)
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
    const frames: { ev?: string; seq?: number }[] = [];
    let gotReset!: () => void;
    const reset = new Promise<void>((r) => { gotReset = r; });
    b.client.watch((e: { ev?: string }) => {
      frames.push(e);
      if (e.ev === 'reset') gotReset();
    });
    await reset;
    await new Promise<void>((r) => setImmediate(r)); // drain anything queued behind it

    assert.equal(frames.length, 1, 'reset only — never a stale replay');
    assertStampedReset(frames[0]);
    assert.equal(frames[0].seq, 3, 'reset teaches the current watermark so the NEXT resume can be covered');
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

    assert.equal(frames.length, 1, 'reset only — never a partial replay');
    assertStampedReset(frames[0]);
  });

  // ── ns6p.4 slice 1: signal-frame epoch + route-provenance drops ──

  it('signal-only client: dirty carries {seq, epoch}, cursor resumes covered — the reset loop is dead (anz4.28e)', async (t) => {
    const { memory, watcher, client, teardown, dial } = await harness(R | S);
    // Node the session cannot read: the ACL filter drops every payload, so
    // this client lives on dirty frames alone.
    const hidden = createNode('/hidden', 't', { v: 1 });
    hidden.$acl = [{ g: 'public', p: 0 }];
    await memory.set(hidden);

    const frames: { ev?: string; path?: string; seq?: number; epoch?: string }[] = [];
    let sawDirty!: () => void;
    const dirty = new Promise<void>((r) => { sawDirty = r; });
    client.watch((e: { ev?: string }) => {
      frames.push(e);
      if (e.ev === 'dirty') sawDirty();
    });
    watcher.watch('wire-anon', ['/views/q'], { children: true });

    watcher.notify({ type: 'set', path: '/hidden', node: { $type: 't', v: 2 }, invalidateVps: ['/views/q'] });
    await dirty;

    const d = frames.find((f) => f.ev === 'dirty');
    assert.equal(d?.path, '/views/q');
    assert.equal(d?.seq, 1);
    const epoch = d?.epoch;
    if (typeof epoch !== 'string') throw new Error('dirty must carry the stream epoch (anz4.28e)');
    assert.deepEqual(client.cursor(), { seq: 1, epoch }, 'client adopted the cursor from signal frames alone');

    teardown();
    client.destroy();
    watcher.notify({ type: 'set', path: '/hidden', node: { $type: 't', v: 3 }, invalidateVps: ['/views/q'] }); // seq 2 — ringed

    const b = dial({ seq: 1, epoch });
    t.after(() => b.client.destroy());
    const resumed: { ev?: string; path?: string; seq?: number }[] = [];
    let caughtUp!: () => void;
    const replayed = new Promise<void>((r) => { caughtUp = r; });
    b.client.watch((e: { ev?: string; seq?: number }) => {
      resumed.push(e);
      if (e.ev === 'dirty' && e.seq === 2) caughtUp();
    });
    await replayed;

    assert.ok(!resumed.some((f) => f.ev === 'reset'), 'covered resume — no reset, the loop is gone');
    const rd = resumed.find((f) => f.ev === 'dirty');
    assert.equal(rd?.path, '/views/q');
    assert.equal(rd?.seq, 2, 'exactly the gap replayed');
  });

  it('ring replay reproduces the SAME invalidate(paths) — provenance frozen in the ring, hold release does not rewrite it', async (t) => {
    const { memory, watcher, client, teardown, dial } = await harness(R | S);
    const hidden = createNode('/hidden', 't', { v: 1 });
    hidden.$acl = [{ g: 'public', p: 0 }];
    await memory.set(hidden);

    // Exact hold on the unreadable path (registered server-side, e.g. before
    // the ACL flipped): the drop must signal THIS path to THIS holder.
    watcher.watch('wire-anon', ['/hidden']);

    const frames: { ev?: string; path?: string; seq?: number; epoch?: string }[] = [];
    let sawDirty!: () => void;
    const dirty = new Promise<void>((r) => { sawDirty = r; });
    client.watch((e: { ev?: string }) => {
      frames.push(e);
      if (e.ev === 'dirty') sawDirty();
    });

    watcher.notify({ type: 'set', path: '/hidden', node: { $type: 't', v: 2 } });
    await dirty;

    const live = frames.find((f) => f.ev === 'dirty');
    assert.equal(live?.path, '/hidden', 'exact holder gets the held path as a dirty signal');
    assert.equal(live?.seq, 1);
    const epoch = live?.epoch;
    if (typeof epoch !== 'string') throw new Error('dirty must carry the stream epoch (anz4.28e)');

    teardown();
    client.destroy();
    // Hold released between event and resume: replay must NOT recompute routes.
    watcher.unwatch('wire-anon', ['/hidden']);

    // Pre-event cursor under the live epoch — forces a ring replay on resume.
    const b = dial({ seq: 0, epoch });
    t.after(() => b.client.destroy());
    const resumed: { ev?: string; path?: string; seq?: number }[] = [];
    let caughtUp!: () => void;
    const replayed = new Promise<void>((r) => { caughtUp = r; });
    b.client.watch((e: { ev?: string; seq?: number }) => {
      resumed.push(e);
      if (e.ev === 'dirty' && e.seq === 1) caughtUp();
    });
    await replayed;

    assert.ok(!resumed.some((f) => f.ev === 'reset'), 'covered resume');
    const rd = resumed.find((f) => f.ev === 'dirty');
    assert.equal(rd?.path, '/hidden', 'the SAME invalidate(paths) — envelope from the ring, not recomputed');
  });
});

// ── ns6p.4 slice 2: plan re-validate after registration (invariants 21+23) ──

describe('registerWatchList — plan re-validate (ns6p.4 slice 2)', () => {
  async function revalidateHarness() {
    const store = createMemoryTree();
    await store.set(createNode('/data', 'dir'));
    const watcher = createWatchManager();
    const lane: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(store, (e) => watcher.notify(e), {
      projectMembership: async (_u, o, n) => [o, n],
    });
    watcher.bindQueryRegistry(cdc);
    watcher.connect('c1', 'u1', (env) => lane.push(env.event), undefined, 'tab');
    return { subTree: tree, watcher, cdc, lane };
  }

  const freshPlan = (source: string, kind: string): ResolvedReadPlan => ({
    plan: { source, callerWhere: { kind } },
    mountDeps: new Set([source]),
  });

  it('stable plan: one registration, one validation probe', async () => {
    const { watcher, cdc } = await revalidateHarness();
    const frozen = freshPlan('/data', 'a');
    let probes = 0;
    const tree = { planChildren: async () => { probes++; return freshPlan('/data', 'a'); } };

    await registerWatchList(watcher, tree, 'u1', '/view', false, 'tab', frozen);

    assert.equal(probes, 1);
    assert.equal(cdc.getActiveQueryCount(), 1);
  });

  it('config flip between freeze and registration: converges on attempt 2 with the FRESH plan active', async () => {
    const { subTree, watcher, cdc, lane } = await revalidateHarness();
    const frozen = freshPlan('/data', 'a');
    let probes = 0;
    // The mount now points at /data2 — every probe returns the flipped plan.
    const tree = { planChildren: async () => { probes++; return freshPlan('/data2', 'a'); } };

    await registerWatchList(watcher, tree, 'u1', '/view', false, 'tab', frozen);

    assert.equal(probes, 2, 'validate after each of the two registration attempts');
    assert.equal(cdc.getActiveQueryCount(), 1);

    // Membership evaluates the FLIPPED plan, not the stale frozen one.
    await subTree.set(createNode('/data2/x', 'item', { kind: 'a' }));
    assert.ok(
      lane.some((e) => e.type !== 'reconnect' && e.invalidateVps?.includes('/view')),
      'flip under the fresh source dirties the view',
    );
    lane.length = 0;
    await subTree.set(createNode('/data/x', 'item', { kind: 'a' }));
    assert.ok(
      !lane.some((e) => e.type !== 'reconnect' && e.invalidateVps?.includes('/view')),
      'the undone frozen plan no longer evaluates',
    );
  });

  it('plan keeps diverging: CONFLICT after 2 attempts, nothing left registered', async () => {
    const store = createMemoryTree();
    const watcher = createWatchManager({ maxWatchesPerUser: 1 });
    const { cdc } = withSubscriptions(store, undefined, {
      projectMembership: async (_u, o, n) => [o, n],
    });
    watcher.bindQueryRegistry(cdc);
    watcher.connect('c1', 'u1', () => {}, undefined, 'tab');

    let n = 0;
    const tree = { planChildren: async () => freshPlan(`/d${++n}`, 'x') };

    await assert.rejects(
      registerWatchList(watcher, tree, 'u1', '/view', false, 'tab', freshPlan('/data', 'x')),
      isCode('CONFLICT'),
    );
    assert.equal(cdc.getActiveQueryCount(), 0, 'no stale query handle survives the CONFLICT');
    // The prefix hold is gone too: with a budget of 1, a fresh registration fits.
    watcher.watch('u1', ['/other'], { children: true, token: 'tab' });
  });

  it('no frozen plan (peer without the pre-step): plain registration, no probe', async () => {
    const { watcher, cdc } = await revalidateHarness();
    const tree = {
      planChildren: async (): Promise<ResolvedReadPlan> => { throw new Error('must not re-resolve without a frozen plan'); },
    };

    await registerWatchList(watcher, tree, 'u1', '/view', false, 'tab', undefined);
    assert.equal(cdc.getActiveQueryCount(), 0, 'plain prefix watch — no query registration');
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

  it('carries epoch on dirty frames and fans provenance paths into dirty (ns6p.4 slice 1)', () => {
    const frames = toEventFrames({ type: 'invalidate', vps: ['/views/a'], paths: ['/data/x'], seq: 9, epoch: 'E1' });
    assert.deepEqual(frames, [
      { seq: 9, epoch: 'E1', ev: 'dirty', path: '/views/a' },
      { seq: 9, epoch: 'E1', ev: 'dirty', path: '/data/x' },
    ]);
  });

  it('stamps the reset from a ring-routed break with {seq, epoch} (anz4.10/11)', () => {
    const frames = toEventFrames({ type: 'reconnect', preserved: false, seq: 12, epoch: 'E2' });
    assert.deepEqual(frames, [{ ev: 'reset', reason: 'resume', seq: 12, epoch: 'E2' }]);
  });

  it('dirty facets of a data event share its seq and epoch', () => {
    const frames = toEventFrames({
      type: 'set', path: '/data/x', node: { $type: 't' }, seq: 3, epoch: 'E1', invalidateVps: ['/views/a'],
    });
    assert.deepEqual(frames, [
      { seq: 3, ev: 'set', path: '/data/x', node: { $type: 't' } },
      { seq: 3, epoch: 'E1', ev: 'dirty', path: '/views/a' },
    ]);
  });
});
