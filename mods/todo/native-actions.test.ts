import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import {
  collectModule,
  R,
  W,
  type DomainId,
  type Gate,
  type Node,
  type OpId,
  type Session,
} from '@treenx/core/kernel';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { scanBudget } from '@treenx/core/kernel/testing';
import itemSchema from './schemas/todo.item.json';
import listSchema from './schemas/todo.list.json';

const listPath = '/todo/list';
const collected = collectModule('@treenx/mods/todo', () => import('./kernel'));
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

/** Releases a held operation at an observed runtime boundary. */
function event() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Reads one genuine visible node and refuses error copies loudly. */
async function node(session: Session, path: string): Promise<Node> {
  const copy = (await session.read({ node: path })).copies[0];
  assert.ok('node' in copy);
  return copy.node;
}

/** Owns ordinary lane delivery while direct action callers await their Pending. */
async function drain(session: Session): Promise<void> {
  for await (const frame of session.lane) assert.notEqual(frame.t, 'chunk');
}

/** Installs the collected module and accepts the existing todo seed through a real admin Session. */
async function fixture(t: TestContext, grant = R | W, gates: readonly Gate[] = []) {
  const parent = resolve(import.meta.dirname, '../../../temp/native-todo-contract');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'instance-'));
  const config = {
    id: `native-todo:${randomUUID()}`,
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    modules: [await collected],
    gates,
  };
  const runtime = await openNativeRuntime(config);
  const runtimes = [runtime],
    deliveries: Promise<void>[] = [];
  t.after(async () => {
    for (const owned of runtimes.reverse()) await owned.close();
    await Promise.all(deliveries);
  });

  /** Uses the actual welcome's intake and issued anonymous credential. */
  async function open(session: Session, pump = true) {
    const welcome = await session.lane[Symbol.asyncIterator]().next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    const frame = welcome.value;
    if (pump) deliveries.push(drain(session));
    return {
      session,
      credential: frame.credential,
      key: (): OpId => ({ epoch: frame.intake, time: Date.now(), nonce: randomUUID() }),
    };
  }

  assert.ok(runtime.instance.setupCredential);
  const adminCredential = runtime.instance.setupCredential;
  const admin = await open(await runtime.instance.openSession(adminCredential));
  await admin.session.commit({
    opId: admin.key(),
    changes: [
      {
        op: 'put',
        node: { $path: '/todo', $type: 't.dir', $acl: [{ subject: { group: 'public' }, grant }] },
      },
      { op: 'put', node: { $path: listPath, $type: 'todo.list', title: 'My Todos' } },
      {
        op: 'put',
        node: {
          $path: `${listPath}/1`,
          $type: 'todo.item',
          title: 'Read the quickstart',
          done: true,
        },
      },
      {
        op: 'put',
        node: { $path: `${listPath}/2`, $type: 'todo.item', title: 'Build something', done: false },
      },
    ],
  }).outcome;
  const caller = await open(await runtime.instance.openSession());
  assert.ok(caller.credential);
  assert.ok(caller.session.actor.principal.startsWith('anon:'));

  /** Captures accepted state and decisions, excluding failed allocation gaps. */
  async function accepted() {
    return {
      nodes: (await runtime.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      journal: (await runtime.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items,
    };
  }

  return { runtime, runtimes, config, admin, adminCredential, caller, open, accepted };
}

describe('native todo business actions', { timeout: 30_000 }, () => {
  it('installs the existing schemas as ordinary native types owned by the collected module', async (t) => {
    const module = await collected;
    const item = module.types.find((type) => type.name === 'todo.item');
    const list = module.types.find((type) => type.name === 'todo.list');
    assert.ok(item && list);
    assert.deepEqual(item.schema.properties, itemSchema.properties);
    assert.deepEqual(item.schema.required, itemSchema.required);
    assert.deepEqual(list.schema.properties, listSchema.properties);
    assert.deepEqual(list.schema.required, listSchema.required);
    assert.equal(item.security, 'ordinary');
    assert.equal(list.security, 'ordinary');
    assert.equal(item.actions.toggle.kind, 'write');
    assert.equal(list.actions.add.kind, 'write');
    assert.deepEqual(module.legacyActions, []);
    assert.deepEqual(module.legacySecurity, []);

    const f = await fixture(t);
    for (const name of ['todo.item', 'todo.list']) {
      const owner = await node(f.admin.session, `/sys/types/${name}`);
      assert.equal(owner.module, module.id);
      assert.equal(owner.security, 'ordinary');
    }
  });

  it('adds a trimmed incomplete item and toggles its real class draft without changing its title', async (t) => {
    const f = await fixture(t);
    const outcome = await f.caller.session.act({
      path: listPath,
      action: 'add',
      args: { title: '  Native checklist  ' },
      opId: f.caller.key(),
    }).outcome;
    assert.equal(outcome.value, undefined);
    const result = await f.caller.session.read({ children: listPath });
    assert.equal(result.list.length, 3);
    const copy = result.copies.find(
      (copy) => 'node' in copy && copy.node.title === 'Native checklist',
    );
    assert.ok(copy && 'node' in copy);
    assert.equal(copy.node.$type, 'todo.item');
    assert.equal(copy.node.done, false);
    await f.caller.session.act({
      path: copy.node.$path,
      action: 'toggle',
      args: {},
      opId: f.caller.key(),
    }).outcome;
    assert.equal((await node(f.caller.session, copy.node.$path)).done, true);
    await f.caller.session.act({
      path: copy.node.$path,
      action: 'toggle',
      args: {},
      opId: f.caller.key(),
    }).outcome;
    const saved = await node(f.caller.session, copy.node.$path);
    assert.equal(saved.done, false);
    assert.equal(saved.title, 'Native checklist');
  });

  it('rejects missing, malformed and blank titles without accepting data or decisions', async (t) => {
    const f = await fixture(t);
    const before = await f.accepted();
    for (const args of [null, undefined, {}, { title: 42 }, { title: '' }, { title: ' \t\n ' }]) {
      await assert.rejects(
        f.caller.session.act({ path: listPath, action: 'add', args, opId: f.caller.key() }).outcome,
        code('INVALID'),
      );
    }
    assert.deepEqual(await f.accepted(), before);
  });

  it('denies ordinary actions to a read-only caller without changing the seeded items', async (t) => {
    const f = await fixture(t, R);
    const before = await f.accepted();
    await assert.rejects(
      f.caller.session.act({
        path: listPath,
        action: 'add',
        args: { title: 'Forbidden add' },
        opId: f.caller.key(),
      }).outcome,
      code('FORBIDDEN'),
    );
    await assert.rejects(
      f.caller.session.act({
        path: `${listPath}/1`,
        action: 'toggle',
        args: {},
        opId: f.caller.key(),
      }).outcome,
      code('FORBIDDEN'),
    );
    assert.deepEqual(await f.accepted(), before);
    assert.equal((await node(f.caller.session, `${listPath}/1`)).done, true);
  });

  it('replays accepted add and toggle keys once and refuses a changed request under the same key', async (t) => {
    const f = await fixture(t);
    const request = {
      path: listPath,
      action: 'add',
      args: { title: 'Once' },
      opId: f.caller.key(),
    };
    const outcome = await f.caller.session.act(request).outcome;
    const before = await f.accepted();
    assert.deepEqual(await f.caller.session.act(request).outcome, outcome);
    await assert.rejects(
      f.caller.session.act({ ...request, args: { title: 'Changed' } }).outcome,
      code('KEY_REUSED'),
    );
    assert.deepEqual(await f.accepted(), before);
    const copy = (await f.caller.session.read({ children: listPath })).copies.find(
      (copy) => 'node' in copy && copy.node.title === 'Once',
    );
    assert.ok(copy && 'node' in copy);

    const toggle = { path: copy.node.$path, action: 'toggle', args: {}, opId: f.caller.key() };
    const toggled = await f.caller.session.act(toggle).outcome;
    assert.equal((await node(f.caller.session, copy.node.$path)).done, true);
    const afterToggle = await f.accepted();
    assert.deepEqual(await f.caller.session.act(toggle).outcome, toggled);
    assert.deepEqual(await f.accepted(), afterToggle);
    assert.equal((await node(f.caller.session, copy.node.$path)).done, true);
  });

  it('creates distinct issued items for genuinely concurrent calls within one clock tick', async (t) => {
    const f = await fixture(t);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const requests = ['Concurrent one', 'Concurrent two'].map((title) => ({
      path: listPath,
      action: 'add',
      args: { title },
      opId: f.caller.key(),
    }));
    const outcomes = await Promise.all(
      requests.map((request) => f.caller.session.act(request).outcome),
    );
    const copies = (await f.caller.session.read({ children: listPath })).copies;
    const one = copies.find((copy) => 'node' in copy && copy.node.title === requests[0].args.title);
    const two = copies.find((copy) => 'node' in copy && copy.node.title === requests[1].args.title);
    assert.ok(one && 'node' in one && two && 'node' in two);
    assert.notEqual(one.node.$path, two.node.$path);
    assert.notEqual(one.node.$id, two.node.$id);
    assert.equal(one.node.done, false);
    assert.equal(two.node.done, false);
    const beforeReplay = await f.accepted();
    assert.deepEqual(
      await Promise.all(requests.map((request) => f.caller.session.act(request).outcome)),
      outcomes,
    );
    assert.deepEqual(await f.accepted(), beforeReplay);
  });

  it('refuses a forced occupied address and a denied destination without overwriting either', async (t) => {
    const f = await fixture(t);
    const now = Date.now(),
      suffix = randomUUID();
    const path = `${listPath}/${now.toString(36)}-${suffix}`;
    await f.admin.session.commit({
      opId: f.admin.key(),
      changes: [
        { op: 'put', node: { $path: path, $type: 'todo.item', title: 'Protected', done: true } },
      ],
    }).outcome;
    const occupied = await node(f.caller.session, path);
    const addKey = f.caller.key(),
      deniedKey = f.caller.key();
    t.mock.method(Date, 'now', () => now);
    t.mock.method(crypto, 'randomUUID', () => suffix);
    const before = await f.accepted();
    await assert.rejects(
      f.caller.session.act({
        path: listPath,
        action: 'add',
        args: { title: 'Replace' },
        opId: addKey,
      }).outcome,
      code('CONFLICT'),
    );
    assert.deepEqual(await f.accepted(), before);
    assert.deepEqual(await node(f.caller.session, path), occupied);

    await f.admin.session.commit({
      opId: f.admin.key(),
      changes: [
        { op: 'patch', path, ops: { $set: { $acl: [{ subject: { group: 'public' }, deny: W }] } } },
      ],
    }).outcome;
    const denied = await f.accepted();
    await assert.rejects(
      f.caller.session.act({
        path: listPath,
        action: 'add',
        args: { title: 'Denied replacement' },
        opId: deniedKey,
      }).outcome,
      code('FORBIDDEN'),
    );
    assert.deepEqual(await f.accepted(), denied);
    const retained = await node(f.caller.session, path);
    assert.equal(retained.$id, occupied.$id);
    assert.equal(retained.title, 'Protected');
    assert.equal(retained.done, true);
  });

  it('retains exact absence as a precondition when an admin inserts the same destination before commit', async (t) => {
    const f = await fixture(t);
    const now = Date.now(),
      suffix = randomUUID();
    const path = `${listPath}/${now.toString(36)}-${suffix}`;
    const request = {
      path: listPath,
      action: 'add',
      args: { title: 'Lost race' },
      opId: f.caller.key(),
    };
    const entered = event(),
      release = event();
    t.after(release.resolve);
    const writer = f.runtime.instance.writer;
    const read = writer.read.bind(writer);
    let hold = true;
    /** Holds an actual negative read after its barrier releases, preserving its captured absence. */
    async function heldRead<V>(domains: readonly DomainId[], run: () => Promise<V>): Promise<V> {
      try {
        return await read(domains, run);
      } catch (error) {
        if (!hold || !(error instanceof KernelError) || error.code !== 'NOT_FOUND') throw error;
        hold = false;
        entered.resolve();
        await release.promise;
        throw error;
      }
    }
    t.mock.method(Date, 'now', () => now);
    t.mock.method(crypto, 'randomUUID', () => suffix);
    t.mock.method(writer, 'read', heldRead);
    const pending = f.caller.session.act(request);
    const refusal = assert.rejects(pending.outcome, code('CONFLICT'));
    await entered.promise;
    await f.admin.session.commit({
      opId: f.admin.key(),
      changes: [
        { op: 'put', node: { $path: path, $type: 'todo.item', title: 'Winner', done: true } },
      ],
    }).outcome;
    const beforeRelease = await f.accepted();
    release.resolve();
    await refusal;
    assert.deepEqual(await f.accepted(), beforeRelease);
    const winner = await node(f.caller.session, path);
    assert.equal(winner.title, 'Winner');
    assert.equal(winner.done, true);
  });

  it('rechecks destination authority after rights change while a real action is held', async (t) => {
    const entered = event(),
      release = event();
    t.after(release.resolve);
    const gate: Gate = async (operation, actor) => {
      if (
        actor.principal.startsWith('anon:') &&
        operation.kind === 'act' &&
        operation.action === 'add'
      ) {
        entered.resolve();
        await release.promise;
      }
      return 'pass';
    };
    const f = await fixture(t, R | W, [gate]);
    const pending = f.caller.session.act({
      path: listPath,
      action: 'add',
      args: { title: 'Revoked add' },
      opId: f.caller.key(),
    });
    const refusal = assert.rejects(pending.outcome, code('FORBIDDEN'));
    await entered.promise;
    await f.admin.session.commit({
      opId: f.admin.key(),
      changes: [
        {
          op: 'patch',
          path: listPath,
          ops: { $set: { $acl: [{ subject: { group: 'public' }, deny: W }] } },
        },
      ],
    }).outcome;
    const beforeRelease = await f.accepted();
    release.resolve();
    await refusal;
    assert.deepEqual(await f.accepted(), beforeRelease);
    assert.equal((await f.caller.session.read({ children: listPath })).list.length, 2);
  });

  it('preserves issued identity, completed data and original-key replay after an actual Fs reopen', async (t) => {
    const f = await fixture(t);
    const request = {
      path: listPath,
      action: 'add',
      args: { title: 'Persistent todo' },
      opId: f.caller.key(),
    };
    const outcome = await f.caller.session.act(request).outcome;
    const copy = (await f.caller.session.read({ children: listPath })).copies.find(
      (copy) => 'node' in copy && copy.node.title === request.args.title,
    );
    assert.ok(copy && 'node' in copy);
    await f.caller.session.act({
      path: copy.node.$path,
      action: 'toggle',
      args: {},
      opId: f.caller.key(),
    }).outcome;
    const accepted = await node(f.caller.session, copy.node.$path);
    await f.runtime.close();
    const reopened = await openNativeRuntime(f.config);
    f.runtimes.push(reopened);
    const caller = await f.open(await reopened.instance.openSession(f.caller.credential));
    assert.deepEqual(await node(caller.session, copy.node.$path), accepted);
    assert.deepEqual(await caller.session.act(request).outcome, outcome);
    assert.equal((await caller.session.read({ children: listPath })).list.length, 3);
    const journal = (await reopened.store.scan({ range: { journal: '/' }, budget: scanBudget() }))
      .items;
    assert.equal(
      journal.filter((record) => record.decision?.opId.nonce === request.opId.nonce).length,
      1,
    );
  });

  it('delivers the accepted item and subscription membership before completing the add request', async (t) => {
    const f = await fixture(t);
    const raw = await f.open(await f.runtime.instance.openSession(f.caller.credential), false);
    const lane = raw.session.lane[Symbol.asyncIterator]();
    const sub = raw.session.sub({ children: listPath });
    const snap = await lane.next();
    assert.ok(!snap.done && snap.value.t === 'snap');
    assert.equal(snap.value.sub, sub);
    assert.equal(snap.value.list.length, 2);
    const pending = raw.session.act({
      path: listPath,
      action: 'add',
      args: { title: 'Delivered todo' },
      opId: raw.key(),
    });
    const position = await lane.next();
    assert.ok(!position.done && position.value.t === 'pos' && position.value.coverage !== true);
    const put = position.value.changes.find(
      (change) =>
        change.op === 'put' && 'node' in change.copy && change.copy.node.title === 'Delivered todo',
    );
    assert.ok(put && put.op === 'put' && 'node' in put.copy);
    const id = put.copy.node.$id;
    const membership = position.value.changes.find(
      (change) => change.op === 'list' && change.sub === sub,
    );
    assert.ok(membership && membership.op === 'list');
    assert.ok(membership.diff.some((change) => 'add' in change && change.add === id));
    const done = await lane.next();
    assert.ok(!done.done && done.value.t === 'done');
    assert.equal(done.value.req, pending.id);
    assert.deepEqual(done.value.pos, position.value.pos);
    assert.equal((await pending.outcome).value, undefined);
    assert.equal((await node(f.caller.session, put.copy.node.$path)).done, false);
  });
});
