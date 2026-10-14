import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { KernelError } from '#errors';
import { decodeChainNode } from '#kernel/chain-index';
import { createAcceptedTargets } from '#kernel/instance-targets';
import { openPersistentWriter } from '#kernel/persistence';
import { createMemoryStore } from './memory';
import { createFsStore } from './fs';
import { scanBudget, storeCommit, storedNode } from './contract';

const budgetError = (error: unknown) => error instanceof KernelError && error.code === 'BUDGET';

it('censuses identity and canonical rights within the byte budget independently of ordinary bodies', async () => {
  const store = createMemoryStore({ domain: 'census' });
  const node = storedNode('/large', {
    payload: 'x'.repeat(16 * 1024 * 1024),
    '#extra': { $type: 'extra', payload: 'y'.repeat(1024 * 1024) },
    $owner: 'u:owner',
    $acl: [{ subject: { owner: true }, grant: 7 }],
  });
  const commit = storeCommit(1, [node]);
  await store.commit(commit);
  const result = await store.scan({ range: { census: '/' }, budget: scanBudget() });
  assert.deepEqual(result.items, [
    {
      $path: node.$path,
      $id: node.$id,
      $pos: commit.pos,
      chain: decodeChainNode(commit.writes[0].node),
    },
  ]);
  assert.ok(result.cost && result.cost.bytes < 1024);
  await assert.rejects(store.scan({ range: { subtree: '/' }, budget: scanBudget() }), budgetError);
  const ordinary = await store.scan({
    range: { node: '/large' },
    budget: { ...scanBudget(), bytes: 20 * 1024 * 1024 },
  });
  assert.deepEqual(ordinary.items, [commit.writes[0].node]);
  store.close();
});

it('retains canonical invalid rights and named-component alerts while charging every metadata row', async () => {
  const nodes = [
    storedNode('/acl', { $acl: 'broken' }),
    storedNode('/owner', { $owner: 42 }),
    storedNode('/component', { '#broken': null }),
  ];
  const store = createMemoryStore({
    domain: 'census-invalid',
    recovered: { nodes, commits: [], writerEpoch: 0 },
  });
  const result = await store.scan({ range: { census: '/' }, budget: scanBudget() });
  for (const node of nodes)
    assert.deepEqual(
      result.items.find((item) => item.$id === node.$id)?.chain,
      decodeChainNode(node),
    );
  for (const budget of [
    { ...scanBudget(), nodes: 2 },
    { ...scanBudget(), bytes: 1 },
    { ...scanBudget(), deadline: 0 },
  ])
    await assert.rejects(store.scan({ range: { census: '/' }, budget }), budgetError);
  store.close();
});

it('stages decoded metadata once and refuses identity collisions before publication', async () => {
  const root = createMemoryStore({ domain: 'root' }),
    target = createMemoryStore({ domain: 'target' });
  const targets = createAcceptedTargets(root, () => target);
  const node = storedNode('/a', { $acl: [{ subject: { group: 'u:actor' }, grant: 7 }] });
  await target.commit(storeCommit(1, [node]));
  const rows = (await target.scan({ range: { census: '/' }, budget: scanBudget() })).items;
  const staged = targets.prepare(target, rows);
  assert.equal(staged.chains.get('/a'), rows[0].chain);
  targets.put(root, { ...node, $path: '/other' });
  assert.throws(
    () => targets.attach(staged),
    (error) => error instanceof KernelError && error.code === 'INVALID',
  );
  targets.remove(root, '/other');
  assert.equal(targets.attach(staged), staged);
  assert.deepEqual([...targets.grantsTo('u:actor')], ['/a']);
  root.close();
  target.close();
});

it('uses accepted filesystem metadata without loading ordinary bodies during census', async () => {
  const parent = resolve('../../fs-census-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'dataset-'));
  const lease = await openPersistentWriter({
    directory: join(directory, '.treenix'),
    instance: 'test',
  });
  const store = await createFsStore({ directory, lease });
  try {
    const node = storedNode('/large', { payload: 'x'.repeat(9 * 1024 * 1024) });
    const commit = storeCommit(1, [node], [], lease.writerEpoch);
    await store.commit(commit);
    const census = await store.scan({ range: { census: '/' }, budget: scanBudget() });
    assert.deepEqual(census.items[0].chain, decodeChainNode(node));
    assert.ok(census.cost && census.cost.bytes < 1024);
    await assert.rejects(
      store.scan({ range: { node: '/large' }, budget: scanBudget() }),
      budgetError,
    );
  } finally {
    await store.close();
    await lease.close();
  }
});
