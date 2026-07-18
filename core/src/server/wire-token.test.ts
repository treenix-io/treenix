// Token threading over the WIRE path (core-anz4.28 a-d, ns6p.4 slice 0):
// registration frames (get/ls) carry the consumer's watch-ownership token
// through peer.handle → ServeHooks → WatchManager, and release (unsub) lands
// on the SAME holder — so one tab's release never strips a co-holding tab.
// The legacy (tokenless) path keeps pre-token semantics: one shared hold.

import { createClient } from '#client/wire';
import { createNode, R, S } from '#core';
import { createPortConn } from '#protocol/port';
import type { Session } from '#security/sessions';
import { withSubscriptions } from '#sub';
import { createWatchManager } from '#sub/watch';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { describe, it } from 'node:test';
import { attachWireSession, createWireSession, type WireDeps } from './wire';

async function harness() {
  const memory = createMemoryTree();
  await memory.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | S }] });
  await memory.set(createNode('/doc', 'dir', { title: 'doc' }));
  await memory.set(createNode('/barrier', 'dir', { n: 0 }));

  const watcher = createWatchManager();
  const { tree } = withSubscriptions(memory, (e) => watcher.notify(e));
  const deps: WireDeps = { tree, systemTree: memory, watcher };
  const session: Session = { userId: 'tok-user', anonymous: true, claims: ['public'] };

  // One "tab": own wire session, own event lane, own consumer token.
  function tab(token?: string) {
    const wire = createWireSession(deps, session);
    const { port1, port2 } = new MessageChannel();
    const teardown = attachWireSession(wire, createPortConn(port1), undefined, token);
    const client = createClient(createPortConn(port2), token === undefined ? undefined : { token });
    return { client, teardown };
  }

  return { watcher, tab };
}

/** Ordered-delivery barrier: once tab B saw /barrier, any /doc event routed to
 *  B would already have arrived — its presence/absence is then decidable. */
function barrierOn(client: ReturnType<typeof createClient>) {
  let hit!: () => void;
  const done = new Promise<void>((r) => { hit = r; });
  return { done, arm: () => client.watchPath('/barrier', () => hit()) };
}

describe('wire token threading (anz4.28 slice 0)', () => {
  it('two tabs, distinct tokens: tab1 release keeps tab2 delivery alive', async (t) => {
    const { watcher, tab } = await harness();
    const a = tab('tok-a');
    const b = tab('tok-b');
    t.after(() => { a.client.destroy(); b.client.destroy(); });

    const bDocEvents: { ev?: string; path?: string }[] = [];
    const aSub = await a.client.watchPath('/doc', () => {});
    await b.client.watchPath('/doc', (e) => bDocEvents.push(e));
    const barrier = barrierOn(b.client);
    await barrier.arm();

    aSub.unsubscribe();
    // The channel is ordered: once this awaited request answers, the
    // fire-and-forget unsub frame ahead of it has been processed.
    await a.client.tree.get('/doc');

    watcher.notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'v2']] });
    watcher.notify({ type: 'patch', path: '/barrier', patches: [['r', 'n', 1]] });
    await barrier.done;

    assert.equal(bDocEvents.filter((e) => e.ev === 'patch').length, 1,
      'tab2 co-hold survives tab1 release');
  });

  it('legacy tokenless tabs share ONE hold: first release strips the co-consumer (pre-token contract)', async (t) => {
    const { watcher, tab } = await harness();
    const a = tab();
    const b = tab();
    t.after(() => { a.client.destroy(); b.client.destroy(); });

    const bDocEvents: unknown[] = [];
    const aSub = await a.client.watchPath('/doc', () => {});
    await b.client.watchPath('/doc', (e) => bDocEvents.push(e));
    const barrier = barrierOn(b.client);
    await barrier.arm();

    aSub.unsubscribe();
    await a.client.tree.get('/doc'); // ordered channel — unsub processed before this answers

    watcher.notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'v2']] });
    watcher.notify({ type: 'patch', path: '/barrier', patches: [['r', 'n', 1]] });
    await barrier.done;

    assert.deepEqual(bDocEvents, [], 'legacy shared hold released for everyone');
  });

  it('ls{watch} registers items under the frame token; tokened unsub releases only that holder', async (t) => {
    const { watcher, tab } = await harness();
    const a = tab('tok-a');
    const b = tab('tok-b');
    t.after(() => { a.client.destroy(); b.client.destroy(); });

    const bDocEvents: { ev?: string }[] = [];
    // tab1 registers /doc (and /barrier) via the ls path with its token.
    await a.client.peer.req.ls('/', { watch: true, token: 'tok-a' });
    await b.client.watchPath('/doc', (e) => bDocEvents.push(e));
    const barrier = barrierOn(b.client);
    await barrier.arm();

    await a.client.peer.req.unsub({ paths: ['/doc'], token: 'tok-a' });

    watcher.notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'v3']] });
    watcher.notify({ type: 'patch', path: '/barrier', patches: [['r', 'n', 2]] });
    await barrier.done;

    assert.equal(bDocEvents.filter((e) => e.ev === 'patch').length, 1,
      'ls-registered release under tok-a leaves tok-b hold intact');
  });
});
