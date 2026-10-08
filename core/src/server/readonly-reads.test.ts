import { createNode, type NodeData, R, register } from '#core';
import { KernelError } from '#errors';
import { withAcl } from '#security/acl-tree';
import { withSubscriptions } from '#sub';
import { clearRegistry } from '#testing';
import { createMemoryTree } from '#tree';
import { withCache } from '#tree/cache';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type ActionCtx, executeAction, executeStream } from './actions';
import { wrapReadOnlyTree } from './readonly-tree';

const forbidden = (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN';

function append(node: NodeData | undefined): void {
  assert.ok(node);
  const list = node.list;
  assert.ok(Array.isArray(list));
  list.push('phantom');
}

async function setup() {
  const raw = createMemoryTree();
  await raw.set({ ...createNode('/', 'dir'), $acl: [{ g: 'readers', p: R }] });
  await raw.set(createNode('/action', 'test.read.outputs'));
  await raw.set(createNode('/victims', 'dir'));
  await raw.set(createNode('/victims/item', 'dir', { list: ['original'] }));
  const cached = withCache(raw);
  return { raw, cached, tree: withAcl(cached, 'alice', ['readers']) };
}

describe('read-only tree results', () => {
  beforeEach(() => clearRegistry());

  for (const listing of [false, true]) {
    for (const streaming of [false, true]) {
      it(`a read ${streaming ? 'stream' : 'action'} cannot mutate cached ${listing ? 'children' : 'node'} data`, async () => {
        const { raw, tree } = await setup();
        register('test.read.outputs', 'schema', () => ({
          type: 'object', properties: {},
          methods: { peek: { arguments: [], kind: 'read' as const, streaming } },
        }));
        const mutate = async (ctx: ActionCtx) => {
          append(listing
            ? (await ctx.tree.getChildren('/victims')).items[0]
            : await ctx.tree.get('/victims/item'));
        };
        register('test.read.outputs', 'action:peek', streaming
          ? async function* (ctx: ActionCtx) { await mutate(ctx); yield 'chunk'; }
          : mutate);

        await assert.rejects(() => streaming
          ? executeStream(tree, '/action', undefined, undefined, 'peek').next()
          : executeAction(tree, '/action', undefined, undefined, 'peek'), forbidden);
        assert.deepEqual((await raw.get('/victims/item'))?.list, ['original']);
        assert.deepEqual((await tree.get('/victims/item'))?.list, ['original']);
      });
    }
  }

  it('scanned nodes stay immutable and closing the scan closes its source', async () => {
    const { cached } = await setup();
    let closed = false;
    const source = {
      ...cached,
      async *scanChildren(path: string) {
        try {
          yield* cached.scanChildren!(path);
        } finally {
          closed = true;
        }
      },
    };
    const readonly = wrapReadOnlyTree(source);
    for await (const entry of readonly.scanChildren!('/victims')) {
      assert.equal(entry.node.$path, '/victims/item');
      assert.throws(() => append(entry.node), forbidden);
      break;
    }
    assert.equal(closed, true);
    assert.deepEqual((await cached.get('/victims/item'))?.list, ['original']);
  });

  it('property descriptors cannot expose mutable nested cache data', async () => {
    const { cached, tree } = await setup();
    const node = await wrapReadOnlyTree(tree).get('/victims/item');
    assert.ok(node);
    const list = Object.getOwnPropertyDescriptor(node, 'list')?.value;
    assert.ok(Array.isArray(list));
    assert.throws(() => list.push('phantom'), forbidden);
    assert.deepEqual((await cached.get('/victims/item'))?.list, ['original']);
  });

  for (const operation of ['prototype', 'extensibility', 'freeze']) {
    it(`a read cannot change the ${operation} of a nested cached object`, async () => {
      const { cached, tree } = await setup();
      const node = await wrapReadOnlyTree(tree).get('/victims/item');
      assert.ok(node && Array.isArray(node.list));
      const list = node.list;
      assert.throws(() => {
        if (operation === 'prototype') Object.setPrototypeOf(list, {});
        else if (operation === 'extensibility') Object.preventExtensions(list);
        else Object.freeze(list);
      }, forbidden);
      const stored = (await cached.get('/victims/item'))?.list;
      assert.ok(Array.isArray(stored));
      assert.equal(Object.getPrototypeOf(stored), Array.prototype);
      assert.equal(Object.isExtensible(stored), true);
      assert.deepEqual(stored, ['original']);
    });
  }

  it('watching cannot mutate shared commit images and closing releases the listener', async () => {
    const { cached } = await setup();
    const { tree } = withSubscriptions(cached);
    let closed = false;
    const source = {
      ...tree,
      async *watch(...args: Parameters<typeof tree.watch>) {
        try {
          yield* tree.watch(...args);
        } finally {
          closed = true;
        }
      },
    };
    const readonly = wrapReadOnlyTree(source);
    const iterator = readonly.watch!({ kind: 'path', path: '/victims/new' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    try {
      await tree.set(createNode('/victims/new', 'dir', { list: ['original'] }));
      const event = (await pending).value;
      assert.equal(event?.type, 'set');
      if (event?.type !== 'set') throw new Error('Expected a committed node image');
      assert.throws(() => append({ $path: event.path, ...event.node }), forbidden);
      assert.deepEqual((await cached.get('/victims/new'))?.list, ['original']);
    } finally {
      await iterator.return?.();
    }
    assert.equal(closed, true);
  });
});
