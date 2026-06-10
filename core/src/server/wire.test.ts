// Wire session over a real MessageChannel — the postMessage host path end-to-end:
// createWireSession + attachWireSession on port1, createClient on port2.
// Covers: ACL fail-closed over the wire, watch registration + filtered event
// delivery, VP deltas → dirty frames, reset verdict, watch release (m77).

import { createClient } from '#client/wire';
import { createNode, R, S, W } from '#core';
import { OpError } from '#errors';
import { createPortConn } from '#protocol/port';
import type { Session } from '#security/auth';
import { createWatchManager } from '#sub/watch';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { describe, it } from 'node:test';
import { attachWireSession, createWireSession, type WireDeps } from './wire';

async function harness(perm: number) {
  const tree = createMemoryTree();
  await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: perm }] });
  await tree.set(createNode('/doc', 'dir', { title: 'doc' }));
  // filterPatches fails closed for ops on fields absent from the stored node —
  // tests must patch EXISTING fields or the event is (correctly) dropped.
  await tree.set(createNode('/barrier', 'dir', { n: 0 }));

  const watcher = createWatchManager();
  const deps: WireDeps = { tree, systemTree: tree, watcher };
  const session: Session = { userId: 'wire-anon', anonymous: true, claims: ['public'] };

  const { port1, port2 } = new MessageChannel();
  const wire = createWireSession(deps, session);
  const detach = attachWireSession(wire, createPortConn(port1));
  const client = createClient(createPortConn(port2));
  return { tree: tree as Tree, watcher, client, detach };
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

    watcher.notify({
      type: 'patch', path: '/doc', patches: [['r', 'title', 'doc2']],
      addVps: ['/views/all'], invalidateVps: ['/views/inbox'],
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
});
