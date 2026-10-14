import { instantiateModule } from '@treenx/core/kernel/manifest';
import { nativeDeclaredModule, type NativeClassDeclaration } from '@treenx/mods/native-module';
import { normalizeType } from '@treenx/core';
import type { TypeSchema } from '@treenx/core/schema/types';
import type { ActionDef, SecurityRegistration } from '@treenx/core/kernel/types';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { KernelError } from '#errors';
import type { JournalCommit } from '#kernel/types';
import { R } from '#kernel/types';

const datasets = fileURLToPath(
  new URL('../../../../../temp/native-fs-external-datasets/', import.meta.url),
);

it(
  'accepts real watched file edits as full globally positioned external records',
  { timeout: 8000 },
  async (t) => {
    const type = `external.item-${randomUUID()}`;
    const replacementType = `external.replacement-${randomUUID()}`;
    const module = await (() => {
      const owner = `external:${randomUUID()}`;
      return instantiateModule(
        {
          collectionId: owner,
          factory: () => {
            const schemas: Record<string, TypeSchema> = {};
            const declaredActions: Record<string, Record<string, ActionDef>> = {};
            const classes: Record<string, NativeClassDeclaration> = {};
            const security: SecurityRegistration[] = [];
            class Item {}
            classes[normalizeType(type)] = {
              cls: Object.assign(Item, { $type: normalizeType(type) }),
              security: 'ordinary',
            };
            schemas[normalizeType(type)] = (() => ({
              $id: type,
              type: 'object',
              properties: { count: { type: 'number' } },
              required: ['count'],
            }))();
            class Replacement {}
            classes[normalizeType(replacementType)] = {
              cls: Object.assign(Replacement, { $type: normalizeType(replacementType) }),
              security: 'ordinary',
            };
            schemas[normalizeType(replacementType)] = (() => ({
              $id: replacementType,
              type: 'object',
              properties: { count: { type: 'number' } },
              required: ['count'],
            }))();

            return {
              manifest: nativeDeclaredModule(owner, schemas, declaredActions, classes, security),
            };
          },
        },
        {},
      );
    })();
    const parent = datasets;
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'live-'));
    const runtime = await openNativeRuntime({
      id: randomUUID(),
      directory,
      rootExternal: 'trusted',
      credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
      modules: [module],
    });
    t.after(() => runtime.close());
    assert.ok(runtime.instance.setupCredential);
    const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
    const delivery = drainSession(admin);
    t.after(async () => {
      admin.close();
      await delivery;
    });
    const original = await admin.commit({
      changes: [{ op: 'put', node: { $path: '/doc', $type: type, count: 1 } }],
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    assert.ok(original.pos);
    let accepted = (_record: JournalCommit) => {};
    const changed = new Promise<JournalCommit>((done) => {
      accepted = done;
    });
    const remove = runtime.instance.writer.stream.observe((event) => {
      if (
        event.t === 'commit' &&
        event.record.kind === 'reconcile' &&
        event.record.entries.some((entry) => entry.path === '/doc')
      )
        accepted(event.record);
    });
    t.after(remove);
    const file = join(directory, 'doc', '$');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...raw, count: 2 }));
    const record = await changed;
    assert.equal(record.executor, `external:${runtime.store.domain}`);
    assert.ok(record.pos.seq > original.pos.seq);
    assert.equal(record.entries[0].change.t, 'reconcile');
    const result = (await admin.read({ node: '/doc' })).copies[0];
    assert.ok('node' in result);
    assert.equal(result.node.count, 2);
    const physical = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(physical.count, 2);
    assert.equal(physical.$pos, undefined);
    const acceptedJournal = await runtime.store.scan({
      range: { journal: '/', after: original.pos },
      budget: { nodes: 100, bytes: 1024 * 1024, exprWork: 10000, deadline: Date.now() + 2000 },
    });
    assert.equal(acceptedJournal.items.filter((item) => item.kind === 'reconcile').length, 1);

    const nextRecord = (predicate: (record: JournalCommit) => boolean) =>
      new Promise<JournalCommit>((done) => {
        const remove = runtime.instance.writer.stream.observe((event) => {
          if (
            event.t === 'commit' &&
            event.record.kind === 'reconcile' &&
            predicate(event.record)
          ) {
            remove();
            done(event.record);
          }
        });
        t.after(remove);
      });
    const invalid = nextRecord((record) => record.entries.some((entry) => entry.path === '/doc'));
    await writeFile(file, JSON.stringify({ ...physical, count: 'invalid' }));
    await invalid;
    const invalidCopy = (await admin.read({ node: '/doc' })).copies[0];
    assert.ok('error' in invalidCopy);
    assert.equal(invalidCopy.error.code, 'INVALID');
    const invalidWindow = await admin.read({
      children: '/',
      where: { count: 'invalid' },
      sort: [['count', 1]],
      window: { limit: 1 },
    });
    assert.equal(invalidWindow.copies.length, 1);
    assert.ok('error' in invalidWindow.copies[0]);
    assert.equal(invalidWindow.copies[0].sort?.count, 'invalid');

    const broken = nextRecord(
      (record) =>
        record.quarantine?.some((change) => change.path === '/doc' && change.fault !== null) ===
        true,
    );
    await writeFile(file, '{');
    await broken;
    await assert.rejects(
      admin.read({ node: '/doc' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.equal(await readFile(file, 'utf8'), '{');

    const repaired = nextRecord(
      (record) =>
        record.quarantine?.some((change) => change.path === '/doc' && change.fault === null) ===
        true,
    );
    await writeFile(file, JSON.stringify(physical));
    await repaired;
    const repairedCopy = (await admin.read({ node: '/doc' })).copies[0];
    assert.ok('node' in repairedCopy);
    assert.equal(repairedCopy.node.count, 2);

    await admin.commit({
      changes: [
        { op: 'put', node: { $path: '/doc/child', $type: 't.dir', label: 'child' } },
        { op: 'put', node: { $path: '/sibling', $type: 't.dir', label: 'sibling' } },
      ],
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    const unknown = nextRecord((record) => record.entries.some((entry) => entry.path === '/doc'));
    await writeFile(
      file,
      JSON.stringify({ ...physical, '#unknown': { $type: `unknown.${randomUUID()}` } }),
    );
    await unknown;
    await assert.rejects(
      admin.read({ node: '/doc' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    const child = (await admin.read({ node: '/doc/child' })).copies[0];
    assert.ok('node' in child);
    assert.equal(child.node.label, 'child');
    const malformedComponent = nextRecord((record) =>
      record.entries.some((entry) => entry.path === '/doc'),
    );
    await writeFile(file, JSON.stringify({ ...physical, '#broken': null }));
    await malformedComponent;
    await assert.rejects(
      admin.read({ node: '/doc' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.ok('node' in (await admin.read({ node: '/doc/child' })).copies[0]);
    for (const authority of [{ $acl: null }, { $owner: {} }]) {
      const denied = nextRecord((record) => record.entries.some((entry) => entry.path === '/doc'));
      await writeFile(file, JSON.stringify({ ...physical, ...authority }));
      await denied;
      await assert.rejects(
        admin.read({ node: '/doc/child' }),
        (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
      );
      const sibling = (await admin.read({ node: '/sibling' })).copies[0];
      assert.ok('node' in sibling);
      assert.equal(sibling.node.label, 'sibling');
    }
    const restored = nextRecord((record) => record.entries.some((entry) => entry.path === '/doc'));
    await writeFile(file, JSON.stringify(physical));
    await restored;
    assert.ok('node' in (await admin.read({ node: '/doc/child' })).copies[0]);
    const replaced = nextRecord((record) => record.entries.some((entry) => entry.path === '/doc'));
    const replacementId = randomUUID();
    await writeFile(
      file,
      JSON.stringify({ ...physical, $id: replacementId, $type: replacementType }),
    );
    const replacementRecord = await replaced;
    const entries = replacementRecord.entries.filter((entry) => entry.path === '/doc');
    assert.deepEqual(
      entries.map((entry) => entry.change.t),
      ['delete', 'create'],
    );
    assert.equal(entries[0].id, physical.$id);
    assert.equal(entries[1].id, replacementId);
    const replacement = (await admin.read({ node: '/doc' })).copies[0];
    assert.ok('node' in replacement);
    assert.equal(replacement.node.$id, replacementId);
    assert.equal(replacement.node.$type, replacementType);

    await admin.commit({
      changes: [{ op: 'put', node: { $path: '/orphan', $type: 't.dir' } }],
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    const badDirectory = join(directory, 'orphan', 'bad');
    await mkdir(badDirectory);
    const badFile = join(badDirectory, '$');
    const quarantined = nextRecord(
      (record) =>
        record.quarantine?.some(
          (change) => change.path === '/orphan/bad' && change.fault !== null,
        ) === true,
    );
    await writeFile(badFile, '{');
    await quarantined;
    await admin.commit({
      changes: [{ op: 'remove', path: '/orphan' }],
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    assert.equal(await readFile(badFile, 'utf8'), '{');
    assert.equal(runtime.store.acceptedFault?.('/orphan/bad')?.invalid, 'chain');
    await assert.rejects(
      admin.read({ node: '/orphan/bad' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    const cleared = nextRecord(
      (record) =>
        record.quarantine?.some(
          (change) => change.path === '/orphan/bad' && change.fault === null,
        ) === true,
    );
    await unlink(badFile);
    await cleared;
    assert.equal(runtime.store.acceptedFault?.('/orphan/bad'), undefined);

    await admin.commit({
      changes: [
        {
          op: 'put',
          node: {
            $path: '/mounted',
            $type: 't.dir',
            '#mount': { $type: 't.mount.memory', pattern: 'child' },
          },
        },
      ],
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    const mountFile = join(directory, 'mounted', '$');
    const mountBody = JSON.parse(await readFile(mountFile, 'utf8'));
    for (const malformed of [null, 'invalid', {}]) {
      const malformedAccepted = nextRecord((record) =>
        record.entries.some((entry) => entry.path === '/mounted'),
      );
      await writeFile(mountFile, JSON.stringify({ ...mountBody, '#mount': malformed }));
      await malformedAccepted;
      await assert.rejects(
        admin.read({ node: '/mounted/child' }),
        (error) => error instanceof KernelError && error.code === 'UNAVAILABLE',
      );
      const sibling = (await admin.read({ node: '/doc' })).copies[0];
      assert.ok('node' in sibling);
      assert.equal(sibling.node.count, 2);
    }
    const mountRepaired = nextRecord((record) =>
      record.entries.some((entry) => entry.path === '/mounted'),
    );
    const { '#mount': _declaration, ...unmounted } = mountBody;
    await writeFile(mountFile, JSON.stringify(unmounted));
    await mountRepaired;
    await assert.rejects(
      admin.read({ node: '/mounted/child' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
  },
);

it(
  'preserves an unreadable physical root instead of creating a fresh administrator',
  { timeout: 8000 },
  async () => {
    const parent = datasets;
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'broken-root-'));
    const file = join(directory, '$');
    await writeFile(file, '{');
    await assert.rejects(
      openNativeRuntime({
        id: randomUUID(),
        directory,
        rootExternal: 'trusted',
        credentialTtlMs: 60_000,
        firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
      }),
      (error) => error instanceof KernelError && error.code === 'INVALID',
    );
    assert.equal(await readFile(file, 'utf8'), '{');
  },
);

it(
  'reconciles stopped physical edits before returning the reopened runtime',
  { timeout: 8000 },
  async (t) => {
    const parent = datasets;
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'stopped-'));
    const config = { id: randomUUID(), directory, credentialTtlMs: 60_000 };
    const first = await openNativeRuntime({
      ...config,
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    });
    assert.ok(first.instance.setupCredential);
    const credential = first.instance.setupCredential;
    const admin = await first.instance.openSession(credential);
    const delivery = drainSession(admin);
    const outcome = await admin.commit({
      changes: [{ op: 'put', node: { $path: '/doc', $type: 't.dir', label: 'before' } }],
      opId: { epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    assert.ok(outcome.pos);
    admin.close();
    await delivery;
    await first.close();
    const file = join(directory, 'doc', '$');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...raw, label: 'after' }));
    const second = await openNativeRuntime({ ...config, rootExternal: 'trusted' });
    t.after(() => second.close());
    const reopened = await second.instance.openSession(credential);
    const reopenedDelivery = drainSession(reopened);
    t.after(async () => {
      reopened.close();
      await reopenedDelivery;
    });
    const copy = (await reopened.read({ node: '/doc' })).copies[0];
    assert.ok('node' in copy);
    assert.equal(copy.node.label, 'after');
    const journal = await second.store.scan({
      range: { journal: '/doc', after: outcome.pos },
      budget: { nodes: 100, bytes: 1024 * 1024, exprWork: 10000, deadline: Date.now() + 2000 },
    });
    assert.ok(
      journal.items.some(
        (record) =>
          record.kind === 'reconcile' && record.executor === `external:${second.store.domain}`,
      ),
    );
  },
);

it(
  'uses current ancestor authority while real reconciliation is paused before acceptance',
  { timeout: 8000 },
  async (t) => {
    await mkdir(datasets, { recursive: true });
    const directory = await mkdtemp(join(datasets, 'authority-'));
    const runtime = await openNativeRuntime({
      id: randomUUID(),
      directory,
      rootExternal: 'trusted',
      credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    });
    let release = () => {};
    t.after(() => {
      release();
      return runtime.close();
    });
    assert.ok(runtime.instance.setupCredential);
    const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
    const adminDelivery = drainSession(admin);
    t.after(async () => {
      admin.close();
      await adminDelivery;
    });
    await admin.commit({
      changes: [
        {
          op: 'put',
          node: {
            $path: '/box',
            $type: 't.dir',
            $acl: [{ subject: { group: 'public' }, grant: R }],
          },
        },
        { op: 'put', node: { $path: '/box/item', $type: 't.dir', label: 'private-after-revoke' } },
        {
          op: 'put',
          node: {
            $path: '/sibling',
            $type: 't.dir',
            $acl: [{ subject: { group: 'public' }, grant: R }],
          },
        },
      ],
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    const publicSession = await runtime.instance.openSession();
    const publicDelivery = drainSession(publicSession);
    t.after(async () => {
      publicSession.close();
      await publicDelivery;
    });
    assert.ok('node' in (await publicSession.read({ node: '/box/item' })).copies[0]);
    const original = runtime.store.readExternal;
    assert.ok(original);
    let entered = () => {};
    const observed = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    let paused = false;
    runtime.store.readExternal = async (paths, budget) => {
      const result = await original(paths, budget);
      if (!paused && paths.includes('/box')) {
        paused = true;
        entered();
        await held;
      }
      return result;
    };
    t.after(() => {
      release();
      runtime.store.readExternal = original;
    });
    const file = join(directory, 'box', '$');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const position = runtime.instance.writer.position;
    await writeFile(
      file,
      JSON.stringify({ ...raw, $acl: [{ subject: { group: 'public' }, deny: R }] }),
    );
    await observed;
    assert.deepEqual(runtime.instance.writer.position, position);
    await assert.rejects(
      publicSession.read({ node: '/box/item' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.ok('node' in (await publicSession.read({ node: '/sibling' })).copies[0]);
    release();
  },
);

it(
  'revalidates a watched candidate after a real queued own commit without an empty external position',
  { timeout: 8000 },
  async (t) => {
    await mkdir(datasets, { recursive: true });
    const directory = await mkdtemp(join(datasets, 'no-op-'));
    const runtime = await openNativeRuntime({
      id: randomUUID(),
      directory,
      rootExternal: 'trusted',
      credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    });
    let release = () => {};
    t.after(() => {
      release();
      return runtime.close();
    });
    assert.ok(runtime.instance.setupCredential);
    const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
    const delivery = drainSession(admin);
    t.after(async () => {
      admin.close();
      await delivery;
    });
    const first = await admin.commit({
      changes: [{ op: 'put', node: { $path: '/doc', $type: 't.dir', label: 'before' } }],
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    assert.ok(first.pos);
    const originalRead = runtime.store.readExternal;
    assert.ok(originalRead);
    let entered = () => {},
      inspected = () => {};
    const observed = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    const revalidated = new Promise<void>((done) => {
      inspected = done;
    });
    let paused = false;
    runtime.store.readExternal = async (paths, budget) => {
      const result = await originalRead(paths, budget);
      if (paths.includes('/doc')) {
        if (!paused) {
          paused = true;
          entered();
          await held;
        } else inspected();
      }
      return result;
    };
    t.after(() => {
      release();
      runtime.store.readExternal = originalRead;
    });
    const file = join(directory, 'doc', '$');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...raw, label: 'after' }));
    await observed;
    const own = runtime.instance.commit(
      [{ op: 'put', node: { $path: '/doc', $type: 't.dir', label: 'after' } }],
      { executor: admin.actor.principal, caller: admin.actor.principal, actor: admin.actor },
    );
    release();
    const accepted = await own;
    await revalidated;
    await runtime.instance.writer.read([runtime.store.domain], async () => {});
    assert.deepEqual(runtime.instance.writer.position, accepted);
    const journal = await runtime.store.scan({
      range: { journal: '/doc', after: first.pos },
      budget: { nodes: 100, bytes: 1024 * 1024, exprWork: 10000, deadline: Date.now() + 2000 },
    });
    assert.equal(journal.items.filter((record) => record.kind === 'reconcile').length, 0);
    const copy = (await admin.read({ node: '/doc' })).copies[0];
    assert.ok('node' in copy);
    assert.equal(copy.node.label, 'after');
  },
);
