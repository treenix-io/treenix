import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { KernelError } from '#errors';
import { runBackfill } from '#kernel/backfill';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { componentEntries } from '#kernel/migrate';
import { createInstance } from '#kernel/instance';
import { createReader } from '#kernel/reader';
import { drainSession } from '#kernel/session-delivery';
import { createMemoryStore } from '#kernel/store/memory';
import { scanBudget } from '#kernel/store/contract';
import {
  DEFAULT_LIMITS,
  type ModuleManifest,
  type Position,
  type PositionCounter,
  type Store,
  type StoreBackfill,
} from '#kernel/types';

/** Metadata paging and progress use genuine accepted Store data and its atomic journal. */
function backfillStore() {
  const raw = createMemoryStore({ domain: randomUUID() });
  let acceptedPages = 0;
  const store: Store = {
    ...raw,
    async commit(commit) {
      await raw.commit(commit);
      if (commit.record.backfill !== undefined) acceptedPages++;
    },
  };
  const backfill: StoreBackfill = {
    async state(type, budget) {
      const result = await raw.scan({
        range: { journal: '/' },
        where: { 'backfill.type': type },
        sort: [
          ['pos.epoch', -1],
          ['pos.seq', -1],
        ],
        limit: 1,
        budget,
      });
      assert.ok(result.cost);
      return { state: result.items[0]?.backfill, cost: result.cost };
    },
    async page(after, budget, limit) {
      const result = await raw.scan({
        range: { children: '/documents' },
        ...(after === undefined ? {} : { where: { $path: { $gt: after } } }),
        sort: [['$path', 1]],
        limit,
        budget,
      });
      return {
        ...result,
        items: result.items.map((node) => ({
          $path: node.$path,
          $id: node.$id,
          $pos: node.$pos,
          main: { $type: node.$type, $v: node.$v },
          named: Object.fromEntries(
            componentEntries(node)
              .filter(([name]) => name !== '')
              .map(([name, component]) => [name, { $type: component.$type, $v: component.$v }]),
          ),
        })),
      };
    },
  };
  return { store, raw, backfill, pages: () => acceptedPages };
}

test('resumes accepted migration backfill while projected field queries remain budgeted', async (t) => {
  const f = backfillStore();
  let saved: Position | undefined;
  const counter: PositionCounter = {
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
    freshEpoch: async (floor) => floor + 1,
  };
  const id = randomUUID();
  const module: ModuleManifest = {
    id: 'backfill-document',
    open: [],
    security: [],
    types: [
      {
        name: 'backfill.document',
        module: 'backfill-document',
        security: 'ordinary',
        version: 0,
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        actions: {},
      },
    ],
  };
  const instance = await createInstance({
    id,
    root: { kind: 'store', store: f.store },
    blobs: createMemoryBlobStore(),
    provisioning: {
      writerEpoch: 1,
      counter,
      domains: [{ store: f.store, epoch: id, persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: {
        kind: 'fresh',
        admin: { path: '/admin', name: 'admin', password: randomUUID() },
      },
    },
    modules: [module],
  });
  t.after(() => instance.close());
  assert.ok(instance.setupCredential);
  const admin = await instance.openSession(instance.setupCredential);
  const delivery = drainSession(admin);
  t.after(async () => {
    admin.close();
    await delivery;
  });
  const key = () => ({
    epoch: instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  });
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/documents', $type: 't.dir' } },
      ...['a', 'b'].map((name) => ({
        op: 'put' as const,
        node: { $path: `/documents/${name}`, $type: 'backfill.document', text: 'indexed' },
      })),
    ],
  }).outcome;
  instance.registry.publish({
    ...module,
    types: module.types.map((type) => ({
      ...type,
      version: 1,
      schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
    })),
    security: [
      {
        type: 'backfill.document',
        context: 'migrate',
        handler: [
          {
            from: 0,
            to: 1,
            up(component) {
              const { text, ...fields } = component;
              return { ...fields, body: text };
            },
          },
        ],
      },
    ],
  });
  Object.assign(f.store, { backfill: f.backfill });
  const options = {
    writer: instance.writer,
    store: f.store,
    registry: instance.registry,
    limits: () => DEFAULT_LIMITS,
    budget: scanBudget,
  };
  await runBackfill({ ...options, active: () => f.pages() < 1 });
  const partial = (await f.backfill.state('backfill.document', scanBudget())).state;
  assert.ok(partial && !partial.complete);
  assert.equal(partial.after, '/documents/a');
  const raw = await f.raw.scan({ range: { children: '/documents' }, budget: scanBudget() });
  assert.deepEqual(
    raw.items.map((node) => node.$v),
    [1, 0],
  );
  const query = { children: '/documents', where: { body: 'indexed' } };
  assert.equal((await admin.read(query)).copies.length, 2);
  const admission = await instance.auth.openCredential(instance.setupCredential);
  t.after(() => admission.close());
  const limited = createReader({
    registry: instance.registry,
    writer: instance.writer,
    admission,
    source: instance.readerSource(scanBudget()),
    budget: { ...scanBudget(), nodes: 1 },
  });
  await assert.rejects(
    limited.read(query),
    (error) => error instanceof KernelError && error.code === 'BUDGET',
  );
  await runBackfill(options);
  const complete = (await f.backfill.state('backfill.document', scanBudget())).state;
  assert.ok(complete?.complete);
  assert.equal(complete.after, '/documents/b');
  assert.equal((await admin.read(query)).copies.length, 2);
  const accepted = await f.raw.scan({ range: { children: '/documents' }, budget: scanBudget() });
  assert.ok(
    accepted.items.every(
      (node) => node.$v === 1 && node.body === 'indexed' && !Object.hasOwn(node, 'text'),
    ),
  );
  const pages = f.pages();
  await runBackfill(options);
  assert.equal(f.pages(), pages);
});
