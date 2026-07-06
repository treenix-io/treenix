// createNodeClient.sub — reactive typed subscription over watchPath.
// Regression core-m77 C32: remove events must reach the subscriber.

import { registerType } from '#comp';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNodeClient } from './handle';
import type { TreenixClient } from './index';

class Doc { title = ''; }
registerType('test.doc', Doc);

type WatchCb = (e: unknown) => void;

/** In-memory TreenixClient — watchPath hands back a manual event injector. */
function fakeClient() {
  const tree = createMemoryTree();
  const watchers = new Map<string, WatchCb>();
  const client: TreenixClient = {
    tree,
    execute: async () => undefined,
    watch: () => { throw new Error('unused'); },
    watchPath: async (path, onEvent) => {
      watchers.set(path, onEvent);
      return { node: await tree.get(path), unsubscribe: () => watchers.delete(path) };
    },
    destroy: () => {},
  };
  return { client, tree, emit: (path: string, e: unknown) => watchers.get(path)!(e) };
}

describe('createNodeClient.sub', () => {
  it('notifies with typed data on set events', async () => {
    const { client, tree, emit } = fakeClient();
    await tree.set({ $path: '/d', $type: 'test.doc', title: 'v1' });

    const seen: string[] = [];
    const nc = createNodeClient(client);
    await nc('/d').sub(Doc, (d) => seen.push(d.title));

    emit('/d', { type: 'set', path: '/d', node: { $type: 'test.doc', title: 'v2' } });
    assert.deepEqual(seen, ['v1', 'v2']);
  });

  it('fires onRemove when the watched node is deleted (C32)', async () => {
    const { client, tree, emit } = fakeClient();
    await tree.set({ $path: '/d', $type: 'test.doc', title: 'v1' });

    let removed = 0;
    const nc = createNodeClient(client);
    await nc('/d').sub(Doc, () => {}, { onRemove: () => removed++ });

    emit('/d', { type: 'remove', path: '/d' });
    assert.equal(removed, 1, 'subscriber learned about the removal');
  });

  it('remove clears the cached node — later notify does not serve dead data', async () => {
    const { client, tree, emit } = fakeClient();
    await tree.set({ $path: '/d', $type: 'test.doc', title: 'v1' });

    const seen: (string | undefined)[] = [];
    const nc = createNodeClient(client);
    await nc('/d').sub(Doc, (d) => seen.push(d.title));

    emit('/d', { type: 'remove', path: '/d' });
    emit('/d', { type: 'set', path: '/d', node: { $type: 'test.doc', title: 'reborn' } });
    assert.deepEqual(seen, ['v1', 'reborn'], 'no stale intermediate notify after remove');
  });
});
