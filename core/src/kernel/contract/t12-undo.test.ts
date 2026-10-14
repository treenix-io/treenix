import assert from 'node:assert/strict';
import { it } from 'node:test';
import { KernelError } from '#errors';
import { createProcessCache } from '#kernel/cache';
import { prepareChangeSet, type ChangeExecutor } from '#kernel/changeset';
import { fixture, put } from '#kernel/contract/changeset-fixture';
import { scanBudget } from '#kernel/store/contract';
import { createRegistry } from '#kernel/registry';
import { createProjector } from '#kernel/projection';
import { A, R, W } from '#kernel/types';
import type { ChangeMember, JournalCommit, StoredNode } from '#kernel/types';

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;
const inverse = (record: JournalCommit): readonly ChangeMember[] =>
  record.entries.map((entry) => ({ op: 'undo', record: { pos: record.pos, id: entry.id } }));
async function node(f: Awaited<ReturnType<typeof fixture>>, path: string): Promise<StoredNode> {
  const found = (await f.nodes()).find((item) => item.$path === path);
  assert.ok(found);
  return found;
}
async function record(f: Awaited<ReturnType<typeof fixture>>) {
  const found = (await f.journal()).at(-1);
  assert.ok(found);
  return found;
}

it('reverses update, deletion and creation using raw images and issued identities', async () => {
  const f = await fixture();
  await f.commit([
    put('/', {}, 'dir'),
    put('/item', { 'a.b': 1, '': 'empty', secret: 'original' }),
  ]);
  const before = await node(f, '/item');
  await f.commit([put('/item', { 'a.b': 2, '': 'changed', secret: 'changed' })]);
  await f.commit(inverse(await record(f)));
  const restored = await node(f, '/item');
  assert.equal(restored.$id, before.$id);
  assert.equal(restored['a.b'], 1);
  assert.equal(restored[''], 'empty');
  assert.equal(restored.secret, 'original');
  await f.commit([{ op: 'remove', path: '/item' }]);
  await f.commit(inverse(await record(f)));
  assert.equal((await node(f, '/item')).$id, before.$id);
  await f.commit([put('/new')]);
  await f.commit(inverse(await record(f)));
  assert.equal(
    (await f.nodes()).some((item) => item.$path === '/new'),
    false,
  );
});

it('reverses a parent and child move once and preserves same-collection swaps', async () => {
  const f = await fixture();
  await f.commit([
    put('/', {}, 'dir'),
    put('/source', {}, 'dir'),
    put('/source/child'),
    put('/a', { value: 'a' }),
    put('/b', { value: 'b' }),
  ]);
  const child = await node(f, '/source/child'),
    a = await node(f, '/a'),
    b = await node(f, '/b');
  await f.commit([{ op: 'move', from: '/source', to: '/destination' }]);
  await f.commit(inverse(await record(f)));
  assert.equal((await node(f, '/source/child')).$id, child.$id);
  assert.equal(
    (await f.nodes()).some((item) => item.$path.startsWith('/destination')),
    false,
  );
  await f.commit([
    { op: 'move', from: '/a', to: '/temp' },
    { op: 'move', from: '/b', to: '/a' },
    { op: 'move', from: '/temp', to: '/b' },
  ]);
  await f.commit(inverse(await record(f)));
  assert.equal((await node(f, '/a')).$id, a.$id);
  assert.equal((await node(f, '/b')).$id, b.$id);
});

it('refuses later descendants and modified images without changing data or journal', async () => {
  const f = await fixture();
  await f.commit([put('/', {}, 'dir'), put('/parent', {}, 'dir')]);
  const creation = await record(f);
  await f.commit([put('/parent/later')]);
  const nodes = await f.nodes(),
    history = await f.journal();
  await assert.rejects(
    f.commit([
      {
        op: 'undo',
        record: {
          pos: creation.pos,
          id: creation.entries.find((entry) => entry.path === '/parent')!.id,
        },
      },
    ]),
    code('CONFLICT'),
  );
  assert.deepEqual(await f.nodes(), nodes);
  assert.deepEqual(await f.journal(), history);
  await f.commit([{ op: 'patch', path: '/parent/later', ops: { $set: { value: 1 } } }]);
  const edit = await record(f);
  await f.commit([{ op: 'patch', path: '/parent/later', ops: { $set: { value: 2 } } }]);
  await assert.rejects(f.commit(inverse(edit)), code('CONFLICT'));
});

it('preserves ordering between undo segments and ordinary members', async () => {
  const f = await fixture();
  await f.commit([put('/', {}, 'dir'), put('/a', { value: 0 }), put('/b', { value: 0 })]);
  await f.commit([{ op: 'patch', path: '/a', ops: { $set: { value: 1 } } }]);
  const a = await record(f);
  await f.commit([{ op: 'patch', path: '/b', ops: { $set: { value: 1 } } }]);
  const b = await record(f);
  await f.commit([
    ...inverse(a),
    { op: 'patch', path: '/a', ops: { $set: { value: 3 } } },
    ...inverse(b),
  ]);
  assert.equal((await node(f, '/a')).value, 3);
  assert.equal((await node(f, '/b')).value, 0);
  await f.commit([{ op: 'patch', path: '/b', ops: { $set: { value: 1 } } }]);
  const next = await record(f),
    nodes = await f.nodes(),
    history = await f.journal();
  await assert.rejects(
    f.commit([{ op: 'patch', path: '/b', ops: { $set: { value: 9 } } }, ...inverse(next)]),
    code('CONFLICT'),
  );
  assert.deepEqual(await f.nodes(), nodes);
  assert.deepEqual(await f.journal(), history);
});

it('compares raw current data before migration and refuses a trusted edit retaining its position', async (t) => {
  const f = await fixture();
  await f.commit([put('/', {}, 'dir'), put('/item', { value: 1 })]);
  await f.commit([{ op: 'patch', path: '/item', ops: { $set: { value: 2 } } }]);
  const edit = await record(f),
    current = await node(f, '/item');
  const external = { ...current, value: 99 };
  const scan = f.store.scan;
  t.mock.method(f.store, 'scan', async (query: Parameters<typeof scan>[0]) => {
    const result = await scan(query);
    return 'node' in query.range ? { ...result, items: [external] } : result;
  });
  await assert.rejects(
    prepareChangeSet(
      { store: f.store, cache: createProcessCache(), registry: f.registry, budget: scanBudget() },
      inverse(edit),
      { ...current.$pos, seq: current.$pos.seq + 1 },
    ),
    code('CONFLICT'),
  );
});

it('compares the unmigrated accepted image and migrates only the inverse payload', async () => {
  const registry = createRegistry();
  const publish = (version: number) =>
    registry.publish({
      id: 'undo',
      open: [],
      types: [
        { name: 'dir', module: 'undo', version: 0, security: 'ordinary', schema: {}, actions: {} },
        { name: 'item', module: 'undo', version, security: 'ordinary', schema: {}, actions: {} },
      ],
      security:
        version === 0
          ? []
          : [
              {
                type: 'item',
                context: 'migrate',
                handler: [
                  {
                    from: 0,
                    to: 1,
                    up: (component) => {
                      const { text, ...fields } = component;
                      return { ...fields, body: text };
                    },
                  },
                ],
              },
            ],
    });
  publish(0);
  const f = await fixture({ registry });
  await f.commit([put('/', {}, 'dir'), put('/item', { text: 'old', secret: 'kept' })]);
  await f.commit([{ op: 'patch', path: '/item', ops: { $set: { text: 'new' } } }]);
  const edit = await record(f),
    accepted = await node(f, '/item');
  publish(1);
  const projected = createProjector({ registry, alert: () => {} })(accepted, A | R);
  assert.ok(projected && 'node' in projected);
  assert.equal(projected.node.body, 'new');
  assert.equal(Object.hasOwn(projected.node, '$pos'), false);
  await f.commit(inverse(edit));
  const after = await node(f, '/item');
  assert.equal(after.$id, accepted.$id);
  assert.equal(after.$v, 1);
  assert.equal(after.body, 'old');
  assert.equal(after.secret, 'kept');
});

it('rejects reconciliation and missing records and keeps current history A mandatory', async () => {
  const f = await fixture();
  const acl = [{ subject: { group: 'users' }, grant: R | W | A }];
  await f.commit([put('/', { $acl: acl }, 'dir'), put('/item', { value: 1 })]);
  const before = await node(f, '/item');
  await f.writer.commit(f.store, [], (pos) => {
    const after = { ...before, value: 2, $pos: pos };
    return {
      writes: [{ path: after.$path, node: after }],
      transitions: [{ id: before.$id, before, after }],
      record: {
        pos,
        kind: 'reconcile',
        executor: 'kernel',
        caller: 'kernel',
        entries: [
          { id: before.$id, path: before.$path, change: { t: 'reconcile', before, after } },
        ],
      },
    };
  });
  await assert.rejects(f.commit(inverse(await record(f))), code('INVALID'));
  await assert.rejects(
    f.commit([{ op: 'undo', record: { pos: { ...before.$pos, seq: 999_999 }, id: before.$id } }]),
    code('NOT_FOUND'),
  );
  await f.commit([{ op: 'patch', path: '/item', ops: { $set: { value: 3 } } }]);
  const edit = await record(f);
  await f.commit([
    {
      op: 'patch',
      path: '/',
      ops: { $set: { $acl: [{ subject: { group: 'users' }, grant: R | W }] } },
    },
  ]);
  const who: ChangeExecutor = {
    executor: 'u:alice',
    caller: 'u:alice',
    actor: { principal: 'u:alice', claims: ['users'] },
  };
  const nodes = await f.nodes(),
    history = await f.journal();
  await assert.rejects(f.commit(inverse(edit), who), code('NOT_FOUND'));
  assert.deepEqual(await f.nodes(), nodes);
  assert.deepEqual(await f.journal(), history);
});

it('restores a legitimately deleted150-node subtree in two parent-first bounded commits', async () => {
  const f = await fixture();
  await f.commit([put('/', {}, 'dir')]);
  await f.commit([
    put('/folder', {}, 'dir'),
    ...Array.from({ length: 99 }, (_, index) => put(`/folder/item${index}`)),
  ]);
  await f.commit(Array.from({ length: 50 }, (_, index) => put(`/folder/item${index + 99}`)));
  const issued = new Map((await f.nodes()).map((item) => [item.$path, item.$id]));
  await f.commit(
    Array.from(
      { length: 100 },
      (_, index): ChangeMember => ({ op: 'remove', path: `/folder/item${index}` }),
    ),
  );
  const first = await record(f);
  await f.commit([{ op: 'remove', path: '/folder' }]);
  const second = await record(f);
  assert.equal(first.entries.length, 100);
  assert.equal(second.entries.length, 50);
  const entries = [
    ...first.entries.map((entry) => ({ entry, pos: first.pos })),
    ...second.entries.map((entry) => ({ entry, pos: second.pos })),
  ].sort((a, b) => a.entry.path.split('/').length - b.entry.path.split('/').length);
  const events: JournalCommit[] = [],
    stop = f.writer.stream.observe((event) => {
      if (event.t === 'commit') events.push(event.record);
    });
  try {
    for (let offset = 0; offset < entries.length; offset += 100)
      await f.commit(
        entries
          .slice(offset, offset + 100)
          .map(({ entry, pos }): ChangeMember => ({ op: 'undo', record: { pos, id: entry.id } })),
      );
  } finally {
    stop();
  }
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((item) => item.entries.length),
    [100, 50],
  );
  for (const item of await f.nodes()) assert.equal(item.$id, issued.get(item.$path));
  assert.equal((await f.nodes()).length, 151);
});
