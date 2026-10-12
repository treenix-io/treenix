import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createTwpClient } from '@treenx/core/client/twp';
import { createTestInstance } from '@treenx/core/kernel/testing';
import type { ChangeMember, ModuleManifest } from '@treenx/core/kernel/types';
import { openTwpLoopback } from '@treenx/core/protocol/twp-loopback';
import prefabModule from '#prefab/kernel';
import { KernelError } from '@treenx/core/errors';

const documents: ModuleManifest = {
  id: 'prefab-documents',
  security: [],
  open: [],
  types: [
    {
      name: 'prefab.document',
      module: 'prefab-documents',
      security: 'ordinary',
      version: 0,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rate: { type: 'number' },
          rows: { type: 'array' },
        },
      },
      actions: {},
    },
  ],
};

it(
  'propagates a native variant chain and reverts or applies one field with its own base',
  { timeout: 10_000 },
  async (t) => {
    const fixture = await createTestInstance({
      modules: [documents, (await prefabModule()).manifest],
      actors: {},
      seed: [
        { $path: '/prefab', $type: 't.prefab', mod: 'documents', name: 'sample', nodes: [] },
        {
          $path: '/source',
          $type: 'prefab.document',
          title: 'original',
          rate: 1,
          rows: [{ id: 'a', label: 'source', amount: 1 }],
        },
      ],
    });
    t.after(() => fixture.close());
    assert.ok(fixture.instance.setupCredential);
    const connection = await openTwpLoopback(fixture.instance, {
      credential: fixture.instance.setupCredential,
      origin: '127.0.0.1',
    });
    const client = createTwpClient(connection, {
      credential: fixture.instance.setupCredential,
      close: connection.close,
    });
    t.after(() => client.close());
    await client.ready;
    const act = async (action: string, args: object) => {
      const pending = client.act({ path: '/prefab', action, args });
      for await (const _chunk of pending.chunks) {
      }
      return (await pending.outcome).value;
    };
    const read = async (path: string) => {
      const copy = (await client.read({ node: path })).copies[0];
      assert.ok('node' in copy);
      return copy.node;
    };
    await act('instantiate', { source: '/source', target: '/variant' });
    await client.commit({
      changes: [
        {
          op: 'patch',
          path: '/variant',
          ops: {
            $set: {
              title: 'local',
              rows: [{ id: 'a', label: 'local', amount: 1 }],
            },
          },
        },
      ],
    }).outcome;
    await act('instantiate', { source: '/variant', target: '/copy' });
    await client.commit({
      changes: [
        {
          op: 'patch',
          path: '/source',
          ops: {
            $set: {
              title: 'upstream',
              rate: 2,
              rows: [
                { id: 'a', label: 'upstream', amount: 2 },
                { id: 'b', label: 'new', amount: 3 },
              ],
            },
          },
        },
      ],
    }).outcome;
    await act('pull', { target: '/variant' });
    await act('pull', { target: '/copy' });
    for (const path of ['/variant', '/copy']) {
      const node = await read(path);
      assert.equal(node.title, 'local');
      assert.equal(node.rate, 2);
      assert.deepEqual(node.rows, [
        { id: 'a', label: 'local', amount: 2 },
        { id: 'b', label: 'new', amount: 3 },
      ]);
    }
    await act('revert', { target: '/variant', field: 'title' });
    assert.equal((await read('/variant')).title, 'upstream');
    await client.commit({
      changes: [{ op: 'patch', path: '/variant', ops: { $set: { rate: 7 } } }],
    }).outcome;
    await act('apply', { target: '/variant', field: 'rate' });
    assert.equal((await read('/source')).rate, 7);
    await act('pull', { target: '/variant' });
    assert.equal((await read('/variant')).rate, 7);
    assert.deepEqual(await act('pull', { target: '/variant' }), { changed: false });
  },
);

it(
  'pulls a subtree while retaining local edits and removed-child marks',
  { timeout: 10_000 },
  async (t) => {
    const fixture = await createTestInstance({
      modules: [documents, (await prefabModule()).manifest],
      actors: {},
      seed: [
        { $path: '/prefab', $type: 't.prefab', mod: 'documents', name: 'sample', nodes: [] },
        { $path: '/source', $type: 'prefab.document', rate: 1 },
        ...['plain', 'edited', 'deleted'].map((name) => ({
          $path: `/source/${name}`,
          $type: 'prefab.document',
          rate: 1,
        })),
      ],
    });
    t.after(() => fixture.close());
    assert.ok(fixture.instance.setupCredential);
    const connection = await openTwpLoopback(fixture.instance, {
      credential: fixture.instance.setupCredential,
      origin: '127.0.0.1',
    });
    const client = createTwpClient(connection, {
      credential: fixture.instance.setupCredential,
      close: connection.close,
    });
    t.after(() => client.close());
    await client.ready;
    const act = async (action: string) => {
      const pending = client.act({
        path: '/prefab',
        action,
        args: { source: '/source', target: '/copy' },
      });
      for await (const _chunk of pending.chunks) {
      }
      return (await pending.outcome).value;
    };
    const read = async (path: string) => {
      const copy = (await client.read({ node: path })).copies[0];
      assert.ok('node' in copy);
      return copy.node;
    };
    await client.commit({
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { changeSet: 2 } } }],
    }).outcome;
    await act('instantiate');
    assert.equal((await read('/copy/plain')).rate, 1);
    const changes = [
      { op: 'patch', path: '/copy/edited', ops: { $set: { rate: 9 } } },
      { op: 'remove', path: '/copy/deleted' },
      { op: 'remove', path: '/source/plain' },
      { op: 'remove', path: '/source/edited' },
      { op: 'put', node: { $path: '/source/new', $type: 'prefab.document', rate: 2 } },
    ] satisfies ChangeMember[];
    for (const change of changes) await client.commit({ changes: [change] }).outcome;
    await act('pull');
    const missing = async (path: string) => {
      await assert.rejects(
        client.read({ node: path }),
        (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
      );
    };
    await missing('/copy/plain');
    await missing('/copy/deleted');
    const edited = await read('/copy/edited');
    assert.equal(edited.rate, 9);
    assert.equal(edited.$prefab, undefined);
    assert.equal((await read('/copy/new')).rate, 2);
    assert.deepEqual(await act('pull'), { changed: false });
    assert.deepEqual(await act('instantiate'), { target: '/copy' });
    await missing('/copy/deleted');
  },
);
