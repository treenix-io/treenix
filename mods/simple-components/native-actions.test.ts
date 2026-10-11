import descriptionSchema from './schemas/t.description.json';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createNode } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import {
  collectModule,
  R,
  W,
  type Node,
  type NodeInput,
  type OpId,
  type Session,
} from '@treenx/core/kernel';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { scanBudget } from '@treenx/core/kernel/testing';
import checklistSchema from './schemas/simple.checklist.json';
import commentsSchema from './schemas/simple.comments.json';
import estimateSchema from './schemas/simple.estimate.json';
import linksSchema from './schemas/simple.links.json';
import tagsSchema from './schemas/simple.tags.json';
import timeTrackSchema from './schemas/simple.time-track.json';

const hostPath = '/work/card';
const componentKeys = ['#checklist', '#tags', '#estimate', '#links', '#comments', '#timeTrack'] as const;
const collected = collectModule('@treenx/mods/simple-components', () => import('./kernel'));

/** Matches one expected kernel error code without depending on its wording. */
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

/** Reads one actual visible node and propagates failed copies. */
async function readNode(session: Session, path: string): Promise<Node> {
  const copy = (await session.read({ node: path })).copies[0];
  if ('error' in copy) throw copy.error;
  return copy.node;
}

/** Narrows JSON object payloads for focused persistence assertions. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an attached component only where the test asserts its persisted payload. */
function componentRecord(node: Node, key: string): Record<string, unknown> {
  const component = node[key];
  assert.ok(isRecord(component));
  return component;
}

/** Reads the first object entry from a component array for timestamp assertions. */
function firstRecord(value: unknown): Record<string, unknown> {
  assert.ok(Array.isArray(value));
  const first = value[0];
  assert.ok(isRecord(first));
  return first;
}

/** Drains a real session lane while direct action callers await their outcomes. */
async function drain(session: Session): Promise<void> {
  for await (const frame of session.lane) assert.notEqual(frame.t, 'chunk');
}

/** Starts an actual session and retains its welcome intake for mutation keys. */
async function openSession(session: Session, deliveries: Promise<void>[]) {
  const welcome = await session.lane[Symbol.asyncIterator]().next();
  assert.ok(!welcome.done && welcome.value.t === 'welcome');
  const frame = welcome.value;
  deliveries.push(drain(session));
  return {
    session,
    key: (): OpId => ({ epoch: frame.intake, time: Date.now(), nonce: randomUUID() }),
  };
}

/** Installs the collected module in an isolated filesystem runtime and seeds real attached components. */
async function fixture(t: TestContext, grant = R | W) {
  const parent = resolve(import.meta.dirname, '../../../temp/native-simple-components-contract');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'instance-'));
  const config = {
    id: `native-simple-components:${randomUUID()}`,
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: `simple-components-${randomUUID()}` },
    modules: [await collected],
  };
  let runtime = await openNativeRuntime(config);
  const runtimes = [runtime];
  const deliveries: Promise<void>[] = [];
  t.after(async () => {
    for (const owned of runtimes.reverse()) await owned.close();
    await Promise.all(deliveries);
  });

  const adminCredential = runtime.instance.setupCredential;
  assert.ok(adminCredential);
  const admin = await openSession(await runtime.instance.openSession(adminCredential), deliveries);
  const caller = await openSession(await runtime.instance.openSession(), deliveries);
  const constructedHost = createNode(hostPath, 't.dir', {}, {
    checklist: { $type: 'simple.checklist', items: [{ id: 1, text: 'Keep', done: false }] },
    tags: { $type: 'simple.tags', items: ['keep'] },
    estimate: { $type: 'simple.estimate', value: 2, unit: 'days' },
    links: { $type: 'simple.links', items: [{ id: 1, url: 'https://keep.example', label: 'Keep' }] },
    comments: { $type: 'simple.comments', items: [] },
    timeTrack: { $type: 'simple.time-track', entries: [], running: false },
  });
  const hostNode: NodeInput = {
    $path: constructedHost.$path,
    $type: constructedHost.$type,
    '#checklist': constructedHost['#checklist'],
    '#tags': constructedHost['#tags'],
    '#estimate': constructedHost['#estimate'],
    '#links': constructedHost['#links'],
    '#comments': constructedHost['#comments'],
    '#timeTrack': constructedHost['#timeTrack'],
  };
  await admin.session.commit({
    opId: admin.key(),
    changes: [
      {
        op: 'put',
        node: {
          ...createNode('/work', 't.dir'),
          $acl: [{ subject: { group: 'public' }, grant }],
        },
      },
      {
        op: 'put',
        node: hostNode,
      },
    ],
  }).outcome;

  /** Invokes one explicit attached-component action through the authenticated caller Session. */
  async function invoke(component: string, action: string, args: unknown, opId = caller.key()) {
    return caller.session.act({ path: hostPath, component, action, args, opId }).outcome;
  }

  /** Reopens the same persistent filesystem instance and authenticates its original admin. */
  async function closeAndReopen() {
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    runtime = await openNativeRuntime(config);
    runtimes.push(runtime);
    const credential = await runtime.instance.auth.login({
      account: '/admin',
      password: config.firstAdmin.password,
    });
    const reopenedAdmin = await openSession(await runtime.instance.openSession(credential), deliveries);
    return { runtime, admin: reopenedAdmin };
  }

  return { config, runtime, admin, caller, deliveries, invoke, closeAndReopen };
}

describe('native simple component actions', { timeout: 30_000 }, () => {
  it('collects all seven declared schemas and all eleven actions without legacy registrations', async () => {
    const module = await collected;
    const expectedSchemas = [
      checklistSchema,
      commentsSchema,
      estimateSchema,
      linksSchema,
      tagsSchema,
      timeTrackSchema,
      descriptionSchema,
    ];
    assert.deepEqual(module.types.map(type => type.name).sort(), expectedSchemas.map(schema => schema.$id).sort());
    assert.deepEqual(module.legacyActions, []);
    assert.deepEqual(module.legacySecurity, []);

    const checklist = module.types.find(type => type.name === 'simple.checklist');
    const comments = module.types.find(type => type.name === 'simple.comments');
    const estimate = module.types.find(type => type.name === 'simple.estimate');
    const links = module.types.find(type => type.name === 'simple.links');
    const tags = module.types.find(type => type.name === 'simple.tags');
    const timeTrack = module.types.find(type => type.name === 'simple.time-track');
    assert.ok(checklist && comments && estimate && links && tags && timeTrack);
    assert.deepEqual(Object.keys(checklist.actions).sort(), ['add', 'remove', 'toggle']);
    assert.deepEqual(Object.keys(comments.actions), ['add']);
    assert.deepEqual(Object.keys(estimate.actions), ['update']);
    assert.deepEqual(Object.keys(links.actions).sort(), ['add', 'remove']);
    assert.deepEqual(Object.keys(tags.actions).sort(), ['add', 'remove']);
    assert.deepEqual(Object.keys(timeTrack.actions).sort(), ['start', 'stop']);
    for (const type of module.types) {
      assert.equal(type.security, 'ordinary');
      for (const action of Object.values(type.actions)) assert.equal(action.kind, 'write');
    }
  });

  it('applies all actions through caller Sessions and preserves unrelated attached components', async (t) => {
    const f = await fixture(t);
    let node = await readNode(f.caller.session, hostPath);

    await f.invoke('#checklist', 'add', { text: '  New task  ' });
    let next = await readNode(f.caller.session, hostPath);
    assert.deepEqual(next['#checklist'], {
      $type: 'simple.checklist',
      $v: 0,
      items: [
        { id: 1, text: 'Keep', done: false },
        { id: 2, text: 'New task', done: false },
      ],
    });
    for (const key of componentKeys.filter(key => key !== '#checklist')) assert.deepEqual(next[key], node[key]);
    node = next;

    await f.invoke('#checklist', 'toggle', { id: 2 });
    next = await readNode(f.caller.session, hostPath);
    assert.deepEqual(next['#checklist'], {
      $type: 'simple.checklist',
      $v: 0,
      items: [
        { id: 1, text: 'Keep', done: false },
        { id: 2, text: 'New task', done: true },
      ],
    });
    for (const key of componentKeys.filter(key => key !== '#checklist')) assert.deepEqual(next[key], node[key]);
    node = next;

    await f.invoke('#checklist', 'remove', { id: 1 });
    next = await readNode(f.caller.session, hostPath);
    assert.deepEqual(next['#checklist'], {
      $type: 'simple.checklist',
      $v: 0,
      items: [{ id: 2, text: 'New task', done: true }],
    });
    for (const key of componentKeys.filter(key => key !== '#checklist')) assert.deepEqual(next[key], node[key]);
    node = next;

    await f.invoke('#tags', 'add', { tag: '  urgent  ' });
    await f.invoke('#tags', 'add', { tag: 'urgent' });
    await f.invoke('#tags', 'remove', { tag: 'keep' });
    await f.invoke('#tags', 'remove', { tag: 'absent' });
    next = await readNode(f.caller.session, hostPath);
    assert.deepEqual(next['#tags'], { $type: 'simple.tags', $v: 0, items: ['urgent'] });
    for (const key of componentKeys.filter(key => key !== '#tags')) assert.deepEqual(next[key], node[key]);
    node = next;

    await f.invoke('#estimate', 'update', { value: 5, unit: 'points' });
    await f.invoke('#estimate', 'update', { value: 6 });
    next = await readNode(f.caller.session, hostPath);
    assert.deepEqual(next['#estimate'], { $type: 'simple.estimate', $v: 0, value: 6, unit: 'points' });
    for (const key of componentKeys.filter(key => key !== '#estimate')) assert.deepEqual(next[key], node[key]);
    node = next;

    await f.invoke('#links', 'add', { url: '  https://new.example  ', label: '  New  ' });
    await f.invoke('#links', 'remove', { id: 1 });
    next = await readNode(f.caller.session, hostPath);
    assert.deepEqual(next['#links'], {
      $type: 'simple.links',
      $v: 0,
      items: [{ id: 2, url: 'https://new.example', label: 'New' }],
    });
    for (const key of componentKeys.filter(key => key !== '#links')) assert.deepEqual(next[key], node[key]);
    node = next;

    const commentBefore = Date.now();
    await f.invoke('#comments', 'add', { text: '  Completed  ', author: '  Ada  ' });
    next = await readNode(f.caller.session, hostPath);
    const comment = firstRecord(componentRecord(next, '#comments').items);
    assert.equal(comment.author, 'Ada');
    assert.equal(comment.text, 'Completed');
    assert.ok(typeof comment.createdAt === 'number' && comment.createdAt >= commentBefore);
    for (const key of componentKeys.filter(key => key !== '#comments')) assert.deepEqual(next[key], node[key]);
    node = next;

    const timerBefore = Date.now();
    await f.invoke('#timeTrack', 'start', {});
    next = await readNode(f.caller.session, hostPath);
    const running = componentRecord(next, '#timeTrack');
    assert.equal(running.$type, 'simple.time-track');
    assert.equal(running.running, true);
    const started = firstRecord(running.entries);
    assert.ok(typeof started.start === 'number' && started.start >= timerBefore);
    assert.equal(started.end, 0);
    for (const key of componentKeys.filter(key => key !== '#timeTrack')) assert.deepEqual(next[key], node[key]);
    node = next;

    await f.invoke('#timeTrack', 'stop', {});
    next = await readNode(f.caller.session, hostPath);
    const stopped = componentRecord(next, '#timeTrack');
    assert.equal(stopped.$type, 'simple.time-track');
    assert.equal(stopped.running, false);
    const stoppedEntry = firstRecord(stopped.entries);
    assert.ok(typeof stoppedEntry.end === 'number' && typeof stoppedEntry.start === 'number');
    assert.ok(stoppedEntry.end >= stoppedEntry.start);
    for (const key of componentKeys.filter(key => key !== '#timeTrack')) assert.deepEqual(next[key], node[key]);
  });

  it('validates action inputs and domain transitions at the caller boundary', async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.invoke('#checklist', 'add', { text: 42 }), code('INVALID'));
    await assert.rejects(f.invoke('#checklist', 'add', { text: '  ' }), code('INVALID'));
    await assert.rejects(f.invoke('#checklist', 'toggle', { id: 999 }), code('NOT_FOUND'));
    await assert.rejects(f.invoke('#estimate', 'update', { value: -1 }), code('INVALID'));
    await assert.rejects(f.invoke('#timeTrack', 'stop', {}), code('CONFLICT'));
    assert.deepEqual((await readNode(f.caller.session, hostPath))['#checklist'], {
      $type: 'simple.checklist',
      $v: 0,
      items: [{ id: 1, text: 'Keep', done: false }],
    });
  });

  it('denies a real read-only caller before running a write action', async (t) => {
    const f = await fixture(t, R);
    await readNode(f.caller.session, hostPath);
    await assert.rejects(f.invoke('#comments', 'add', { text: 'Denied' }), code('FORBIDDEN'));
    assert.deepEqual((await readNode(f.admin.session, hostPath))['#comments'], {
      $type: 'simple.comments',
      $v: 0,
      items: [],
    });
  });

  it('replays comment creation once, persists its journal decision, and survives filesystem reopen', async (t) => {
    const f = await fixture(t);
    const opId = f.caller.key();
    const request = {
      path: hostPath,
      component: '#comments',
      action: 'add',
      args: { text: 'Persisted once' },
      opId,
    };
    await f.caller.session.act(request).outcome;
    const first = await readNode(f.caller.session, hostPath);
    const firstComment = firstRecord(componentRecord(first, '#comments').items);
    await f.caller.session.act(request).outcome;

    const second = await readNode(f.caller.session, hostPath);
    const secondComment = firstRecord(componentRecord(second, '#comments').items);
    assert.deepEqual(second['#comments'], first['#comments']);
    assert.equal(secondComment.createdAt, firstComment.createdAt);

    const journal = (await f.runtime.store.scan({ range: { journal: hostPath }, budget: scanBudget() })).items;
    const decisions = journal.filter(commit => commit.decision?.opId.nonce === opId.nonce);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].kind, 'commit');
    assert.equal(decisions[0].caller, f.caller.session.actor.principal);
    assert.equal(decisions[0].executor, f.caller.session.actor.principal);
    assert.equal(decisions[0].entries.length, 1);

    const reopened = await f.closeAndReopen();
    const persisted = await readNode(reopened.admin.session, hostPath);
    assert.deepEqual(persisted['#comments'], first['#comments']);
  });
});
