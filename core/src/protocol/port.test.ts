// TWP over MessageChannel — postMessage transport mechanics (structured clone, no JSON).

import { createNode } from '#core';
import { createMemoryTree } from '#tree';
import { createClient } from '#client/wire';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { describe, it } from 'node:test';
import { createPeer, type PeerServe } from './peer';
import { createPortConn } from './port';

async function hostAndClient(serve: PeerServe) {
  const { port1, port2 } = new MessageChannel();
  const host = createPeer(() => serve);
  host.attach(createPortConn(port1));
  const client = createClient(createPortConn(port2));
  return { host, client };
}

describe('TWP over MessageChannel (postMessage)', () => {
  it('roundtrip preserves structured data without stringify', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/seed', 'dir', {}));
    const { client } = await hostAndClient({ tree });

    const payload = {
      $path: '/doc',
      $type: 'note',
      title: 'Привет 🌳',
      tags: ['a', 'b'],
      nested: { deep: [{ n: 1 }, { n: 2 }], flag: true },
    };
    await client.tree.set(payload);
    const node = await client.tree.get('/doc');
    assert.deepEqual(node, { ...payload, $rev: 1 });

    client.destroy();
  });

  it('act stream flows and cancel crosses the channel', async () => {
    const tree = createMemoryTree();
    let torndown: () => void;
    const done = new Promise<void>((r) => { torndown = r; });
    const { client } = await hostAndClient({
      tree,
      executeStream: async function* (_req, signal) {
        signal.addEventListener('abort', () => torndown());
        // Real handlers await IO between yields — model that with an event-loop
        // hop, or the microtask-only loop starves the port's macrotask delivery.
        for (let i = 0; ; i++) { yield i; await new Promise<void>((r) => setImmediate(r)); }
      },
    });

    const got: unknown[] = [];
    for await (const ch of client.peer.req.actStream({ path: '/seed', action: 'tick' })) {
      got.push(ch);
      if (got.length === 3) break;
    }
    assert.deepEqual(got, [0, 1, 2]);
    await done;

    client.destroy();
  });

  it('events cross the port to watch subscribers', async () => {
    const tree = createMemoryTree();
    const { host, client } = await hostAndClient({ tree });

    const first = new Promise((resolve) => {
      const sub = client.watch((e: unknown) => { resolve(e); sub.unsubscribe(); });
    });
    host.emit({ seq: 7, ev: 'rm', path: '/gone' });
    assert.deepEqual(await first, { seq: 7, ev: 'rm', path: '/gone' });

    client.destroy();
  });
});
