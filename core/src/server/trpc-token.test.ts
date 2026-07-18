// zod token threading (core-anz4.28 d): the tRPC inputs that used to STRIP the
// client's tab token now pass it to the wire frames, so registrations land on
// per-tab holders. Asserted via routed behavior (a push lane receives or not),
// never via WatchManager internals.

import { createNode, R, S, W } from '#core';
import type { Session } from '#security/sessions';
import { type NodeEvent, withSubscriptions } from '#sub';
import { createWatchManager, type StampedEvent, type WatchManager } from '#sub/watch';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTreeRouter } from './trpc';

const USER = 'zod-user';

async function harness() {
  const memory = createMemoryTree();
  await memory.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | W | S }] });
  await memory.set(createNode('/doc', 'dir', { title: 'doc' }));
  await memory.set(createNode('/barrier', 'dir', { n: 0 }));
  await memory.set(createNode('/dir', 'dir', {}));
  await memory.set(createNode('/dir/kid', 'dir', {}));

  const watcher: WatchManager = createWatchManager();
  const { tree } = withSubscriptions(memory, (e) => watcher.notify(e));
  const router = createTreeRouter(tree, memory, watcher);
  const session: Session = { userId: USER, anonymous: true, claims: ['public'] };
  const caller = router.createCaller({ session, token: 'auth.test', clientIp: null });

  // Direct push lane: if the user still holds the path, notify routes here.
  const received: StampedEvent[] = [];
  const waiters: ((e: StampedEvent) => void)[] = [];
  watcher.connect(`${USER}:lane`, USER, ({ event: e }) => {
    received.push(e);
    waiters.splice(0).forEach((w) => w(e));
  });
  const nextEvent = () => new Promise<StampedEvent>((r) => waiters.push(r));

  const notify = (e: NodeEvent) => watcher.notify(e);
  return { caller, notify, received, nextEvent };
}

/** Data events carry a path; the reconnect variant does not. */
const pathOf = (e: StampedEvent): string | undefined => ('path' in e ? e.path : undefined);

describe('tRPC token threading (anz4.28 slice 0)', () => {
  it('get+unwatch: token reaches the holder — tab1 release keeps tab2 registration', async () => {
    const { caller, notify, received, nextEvent } = await harness();

    await caller.get({ path: '/doc', watch: true, token: 'tab-1' });
    await caller.get({ path: '/doc', watch: true, token: 'tab-2' });
    await caller.unwatch({ paths: ['/doc'], token: 'tab-1' });

    const p = nextEvent();
    notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'v2']] });
    const e = await p;
    assert.equal(pathOf(e), '/doc', 'tab-2 hold survived tab-1 unwatch');

    // Releasing the LAST holder ends delivery: barrier proves the absence.
    await caller.unwatch({ paths: ['/doc'], token: 'tab-2' });
    await caller.get({ path: '/barrier', watch: true, token: 'tab-2' });
    const b = nextEvent();
    notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'v3']] });
    notify({ type: 'patch', path: '/barrier', patches: [['r', 'n', 1]] });
    assert.equal(pathOf(await b), '/barrier');
    assert.equal(received.filter((x) => pathOf(x) === '/doc').length, 1,
      'no /doc delivery after the last holder released');
  });

  it('resolve{watch} registers under its token (release via tokened unwatch)', async () => {
    const { caller, notify, received, nextEvent } = await harness();

    await caller.resolve({ path: '/doc', watch: true, token: 'tab-1' });
    await caller.unwatch({ paths: ['/doc'], token: 'other-tab' }); // wrong holder — no-op

    const p = nextEvent();
    notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'v2']] });
    assert.equal(pathOf(await p), '/doc', 'foreign-token unwatch must not strip the hold');

    await caller.unwatch({ paths: ['/doc'], token: 'tab-1' });
    await caller.get({ path: '/barrier', watch: true, token: 'tab-1' });
    const b = nextEvent();
    notify({ type: 'patch', path: '/doc', patches: [['r', 'title', 'v3']] });
    notify({ type: 'patch', path: '/barrier', patches: [['r', 'n', 1]] });
    assert.equal(pathOf(await b), '/barrier');
    assert.equal(received.filter((x) => pathOf(x) === '/doc').length, 1);
  });

  it('getChildren{watchNew}+unwatchChildren: prefix holder is token-scoped', async () => {
    const { caller, notify, nextEvent } = await harness();

    await caller.getChildren({ path: '/dir', watchNew: true, token: 'tab-1' });
    await caller.getChildren({ path: '/dir', watchNew: true, token: 'tab-2' });
    await caller.unwatchChildren({ paths: ['/dir'], token: 'tab-1' });

    const p = nextEvent();
    notify({ type: 'set', path: '/dir/new', node: { $path: '/dir/new', $type: 'dir' } });
    assert.equal(pathOf(await p), '/dir/new', 'tab-2 prefix hold survived tab-1 release');
  });

  it('events verdict: the initial reconnect carries {seq, epoch} (anz4.28e, ns6p.4 slice 1)', async () => {
    const { caller } = await harness();

    const obs = await caller.events({ token: 'tab-1' });
    const first = await new Promise<{ type?: string; seq?: unknown; epoch?: unknown }>((resolve, reject) => {
      const sub = obs.subscribe({
        next: (e) => {
          resolve(e);
          queueMicrotask(() => sub.unsubscribe());
        },
        error: reject,
      });
    });

    assert.equal(first.type, 'reconnect');
    assert.equal(typeof first.seq, 'number', 'verdict must carry the current seq');
    assert.equal(typeof first.epoch, 'string', 'verdict must carry the stream epoch — a signal-only client needs it to resume');
  });
});
