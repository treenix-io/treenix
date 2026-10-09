import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { createTwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import {
  R,
  type Connection,
  type Gate,
  type ModuleManifest,
  type Position,
  type Request,
  type SubSelector,
} from '@treenx/core/kernel/types';
import { createInstanceFoundation } from '../../../../core/src/kernel/instance';
import { createMemoryStore } from '../../../../core/src/kernel/store/memory';
import { NativeTreeBrowser } from '#native/NativeEditor';
import {
  createNativeTreeSource,
  type NativeSnapshot,
  type NativeTreeSource,
} from '#tree/native-source';
import { NativeSourceProvider } from '#tree/native-source-context';

/** Coordinates actual gate and lane boundaries without a timed delay. */
function event() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Waits for an actual snapshot publication of the specified browser listing. */
function until(source: NativeTreeSource, parent: string, count: number): Promise<void> {
  const selector: SubSelector = { children: parent, window: { limit: 100 } };
  const ready = (snapshot: NativeSnapshot) =>
    snapshot.phase === 'ready' && snapshot.members.length === count;
  if (ready(source.getSnapshot(selector))) return Promise.resolve();
  return new Promise((done) => {
    const unsubscribe = source.subscribe(selector, () => {
      if (ready(source.getSnapshot(selector))) {
        unsubscribe();
        done();
      }
    });
  });
}

/** Boots a genuine action, admitted Session, client and source with two independently browsable lists. */
async function fixture(id: string, gates: readonly Gate[] = [], readOnly = false) {
  const module: ModuleManifest = {
    id: 'browser-list-actions',
    security: [],
    open: [],
    types: [
      {
        name: 'browser.list-item',
        module: 'browser-list-actions',
        security: 'ordinary',
        version: 0,
        schema: {},
        actions: {
          create: {
            kind: 'write',
            args: {},
            handler: async (ctx) => {
              for (const parent of ['/items', '/elsewhere']) {
                await ctx.requireReadWrite(`${parent}/z`);
                ctx.change.put({ $path: `${parent}/z`, $type: 't.dir', value: 'accepted' });
              }
            },
          },
        },
      },
    ],
  };
  const root = createMemoryStore({ domain: id });
  let saved: Position | undefined,
    sequence = 0;
  const instance = await createInstanceFoundation({
    id,
    root,
    writerEpoch: 1,
    counter: {
      async load() {
        return saved;
      },
      async save(pos) {
        saved = pos;
      },
      async freshEpoch(floor) {
        return floor + 1;
      },
    },
    domains: [{ store: root, epoch: `${id}:memory`, persistent: false }],
    gates,
    firstAdmin: { path: '/admin', name: 'admin', password: 'native-list-refresh-password' },
    initialCredential: { ttlMs: 60_000 },
  });
  assert.ok(instance.setupCredential);
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential));
  const key = () => ({
    epoch: instance.writer.intake.epoch,
    time: Date.now(),
    nonce: String(++sequence),
  });
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/sys/types/browser.list-item',
          $type: 't.type',
          name: 'browser.list-item',
          module: module.id,
          security: 'ordinary',
        },
      },
    ],
  });
  instance.registry.publish(module);
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/items',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      { op: 'put', node: { $path: '/items/a', $type: 'browser.list-item', value: 1 } },
      { op: 'put', node: { $path: '/elsewhere', $type: 't.dir' } },
      { op: 'put', node: { $path: '/elsewhere/a', $type: 't.dir', value: 1 } },
    ],
  });
  const lane = await instance.openSession(readOnly ? undefined : instance.setupCredential);
  const sent: Request[] = [],
    completed = event();
  const connection: Connection = {
    frames: {
      async *[Symbol.asyncIterator]() {
        for await (const frame of lane.frames) {
          yield frame;
          if (frame.t === 'done' || frame.t === 'fail') completed.resolve();
        }
      },
    },
    send(request) {
      sent.push(request);
      if (request.t === 'hi')
        throw new KernelError('UNAVAILABLE', 'The admitted loopback is already open');
      if (request.t === 'read') {
        if ('history' in request.selector)
          throw new KernelError('UNAVAILABLE', 'History is unavailable on this lane');
        lane.accept({ t: 'read', req: request.req, selector: request.selector });
        return;
      }
      lane.accept(request);
    },
  };
  const client = createTwpClient(connection, { close: () => lane.close() });
  await client.ready;
  const source = createNativeTreeSource(client);
  return {
    admin,
    key,
    source,
    client,
    sent,
    completed,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(NativeSourceProvider, { source, children }),
    /** Releases every resource owned by the rendered fixture. */
    async close() {
      cleanup();
      source.close();
      client.close();
      admin.close();
      await instance.close();
    },
  };
}

/** Opens one address using the actual browser controls. */
function open(browser: ReturnType<typeof render>, parent: string): void {
  fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: parent } });
  fireEvent.click(browser.getByRole('button', { name: 'Открыть' }));
}

/** Sends one user action through the actual editor form. */
function execute(browser: ReturnType<typeof render>, action: string, args = '{}'): void {
  fireEvent.change(browser.getByLabelText('Действие'), { target: { value: action } });
  fireEvent.change(browser.getByLabelText('Аргументы JSON'), { target: { value: args } });
  fireEvent.click(browser.getByRole('button', { name: 'Выполнить' }));
}

describe('native browser listing refresh', { timeout: 30_000 }, () => {
  it('shows an accepted sibling from a child action and preserves the selected child draft', async (t) => {
    const f = await fixture('browser-list-accepted');
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    fireEvent.click(browser.getByRole('button', { name: '/items/a' }));
    const editor = browser.getByLabelText('Данные узла');
    assert.ok(editor instanceof window.HTMLTextAreaElement);
    const draft = JSON.parse(editor.value);
    draft.value = 'unsaved';
    fireEvent.change(editor, { target: { value: JSON.stringify(draft) } });
    await act(async () => {
      execute(browser, 'create');
      await f.completed.promise;
      await until(f.source, '/items', 2);
    });
    assert.ok(browser.queryByRole('button', { name: '/items/z' }));
    assert.equal(browser.queryByRole('alert'), null);
    const retained = browser.getByLabelText('Данные узла');
    assert.ok(retained instanceof window.HTMLTextAreaElement);
    assert.equal(JSON.parse(retained.value).value, 'unsaved');
    const request = f.sent.find((request) => request.t === 'act');
    assert.ok(request?.t === 'act');
    assert.equal(request.path, '/items/a');
    assert.equal(
      f.source.getSnapshot({ children: '/items', window: { limit: 100 } }).members.length,
      2,
    );
  });

  it('refreshes the current parent when navigation happens while the old editor action is pending', async (t) => {
    const entered = event(),
      release = event();
    t.after(release.resolve);
    const gate: Gate = async (operation) => {
      if (operation.kind === 'act') {
        entered.resolve();
        await release.promise;
      }
      return 'pass';
    };
    const f = await fixture('browser-list-navigation', [gate]);
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    fireEvent.click(browser.getByRole('button', { name: '/items/a' }));
    execute(browser, 'create');
    await entered.promise;
    open(browser, '/elsewhere');
    await act(async () => {
      await until(f.source, '/elsewhere', 1);
    });
    await act(async () => {
      release.resolve();
      await f.completed.promise;
      await until(f.source, '/elsewhere', 2);
    });
    assert.ok(browser.queryByRole('button', { name: '/elsewhere/z' }));
    assert.equal(
      f.source.getSnapshot({ children: '/elsewhere', window: { limit: 100 } }).members.length,
      2,
    );
    assert.equal(browser.queryByRole('button', { name: '/items/z' }), null);
    assert.equal(browser.queryByRole('alert'), null);
  });

  it('leaves the list window and dirty draft intact when the server rejects the action', async (t) => {
    const gate: Gate = async (operation) =>
      operation.kind === 'act' ? { refuse: 'REFUSED' } : 'pass';
    const f = await fixture('browser-list-refused', [gate]);
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    fireEvent.click(browser.getByRole('button', { name: '/items/a' }));
    const editor = browser.getByLabelText('Данные узла');
    assert.ok(editor instanceof window.HTMLTextAreaElement);
    const draft = JSON.parse(editor.value);
    draft.value = 'unsaved';
    fireEvent.change(editor, { target: { value: JSON.stringify(draft) } });
    const before = f.sent.filter(
      (request) =>
        request.t === 'sub' &&
        'children' in request.selector &&
        request.selector.children === '/items',
    ).length;
    await act(async () => {
      execute(browser, 'create');
      await f.completed.promise;
    });
    assert.equal(browser.getByRole('alert').textContent?.startsWith('REFUSED:'), true);
    assert.equal(browser.queryByLabelText('Ответ действия'), null);
    assert.equal(
      f.sent.filter(
        (request) =>
          request.t === 'sub' &&
          'children' in request.selector &&
          request.selector.children === '/items',
      ).length,
      before,
    );
    assert.equal(
      f.source.getSnapshot({ children: '/items', window: { limit: 100 } }).members.length,
      1,
    );
    const button = browser.getByRole('button', { name: 'Выполнить' });
    assert.ok(button instanceof window.HTMLButtonElement);
    assert.equal(button.disabled, false);
    assert.equal(JSON.parse(editor.value).value, 'unsaved');
  });

  it('refreshes the browsed parent only after an actual guarded JSON save succeeds', async (t) => {
    const f = await fixture('browser-list-save');
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    fireEvent.click(browser.getByRole('button', { name: '/items/a' }));
    const editor = browser.getByLabelText('Данные узла');
    assert.ok(editor instanceof window.HTMLTextAreaElement);
    const draft = JSON.parse(editor.value);
    draft.value = 'saved';
    fireEvent.change(editor, { target: { value: JSON.stringify(draft) } });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: '/items/z', $type: 't.dir' } }],
    });
    assert.equal(
      f.source.getSnapshot({ children: '/items', window: { limit: 100 } }).members.length,
      1,
    );
    await act(async () => {
      fireEvent.click(browser.getByRole('button', { name: 'Сохранить' }));
      await f.completed.promise;
      await until(f.source, '/items', 2);
    });
    assert.ok(browser.getByRole('button', { name: '/items/z' }));
    assert.equal(JSON.parse(editor.value).value, 'saved');
    const save = browser.getByRole('button', { name: 'Сохранить' });
    assert.ok(save instanceof window.HTMLButtonElement);
    assert.equal(save.disabled, true);
    assert.equal(browser.queryByRole('alert'), null);
  });

  it('preserves the dirty draft and old window when a concurrent edit makes JSON save conflict', async (t) => {
    const f = await fixture('browser-list-save-conflict');
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    fireEvent.click(browser.getByRole('button', { name: '/items/a' }));
    const editor = browser.getByLabelText('Данные узла');
    assert.ok(editor instanceof window.HTMLTextAreaElement);
    const draft = JSON.parse(editor.value);
    draft.value = 'unsaved';
    fireEvent.change(editor, { target: { value: JSON.stringify(draft) } });
    const changed = event();
    const unsubscribe = f.source.subscribe({ node: '/items/a' }, () => {
      const copy = f.source.getSnapshot({ node: '/items/a' }).members[0];
      if (copy !== undefined && 'node' in copy && copy.node.value === 2) changed.resolve();
    });
    await act(async () => {
      await f.admin.commit({
        opId: f.key(),
        changes: [
          { op: 'patch', path: '/items/a', ops: { $set: { value: 2 } } },
          { op: 'put', node: { $path: '/items/z', $type: 't.dir' } },
        ],
      });
      await changed.promise;
    });
    unsubscribe();
    const before = f.sent.filter((request) => request.t === 'sub').length;
    await act(async () => {
      fireEvent.click(browser.getByRole('button', { name: 'Сохранить' }));
      await f.completed.promise;
    });
    assert.equal(browser.getByRole('alert').textContent?.startsWith('CONFLICT:'), true);
    assert.equal(f.sent.filter((request) => request.t === 'sub').length, before);
    assert.equal(JSON.parse(editor.value).value, 'unsaved');
    assert.equal(browser.queryByRole('button', { name: '/items/z' }), null);
    const saved = (await f.client.read({ node: '/items/a' })).copies[0];
    assert.ok('node' in saved);
    assert.equal(saved.node.value, 2);
  });

  it('keeps a readable list unchanged on invalid JSON and a real write-action authorization refusal', async (t) => {
    const f = await fixture('browser-list-read-only', [], true);
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    fireEvent.click(browser.getByRole('button', { name: '/items/a' }));
    const before = f.sent.filter((request) => request.t === 'sub').length;
    await act(async () => {
      execute(browser, 'create', '{broken');
    });
    assert.ok(browser.getByRole('alert'));
    assert.equal(
      f.sent.some((request) => request.t === 'act'),
      false,
    );
    assert.equal(f.sent.filter((request) => request.t === 'sub').length, before);
    await act(async () => {
      execute(browser, 'create');
      await f.completed.promise;
    });
    assert.equal(browser.getByRole('alert').textContent?.startsWith('FORBIDDEN:'), true);
    assert.equal(f.sent.filter((request) => request.t === 'sub').length, before);
    assert.equal(browser.queryByLabelText('Данные узла'), null);
    assert.equal(
      f.source.getSnapshot({ children: '/items', window: { limit: 100 } }).members.length,
      1,
    );
  });

  it('does not reacquire a list after its browser unmounts while an accepted action is pending', async (t) => {
    const entered = event(),
      release = event();
    t.after(release.resolve);
    const gate: Gate = async (operation) => {
      if (operation.kind === 'act') {
        entered.resolve();
        await release.promise;
      }
      return 'pass';
    };
    const f = await fixture('browser-list-unmounted', [gate]);
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    fireEvent.click(browser.getByRole('button', { name: '/items/a' }));
    execute(browser, 'create');
    await entered.promise;
    browser.unmount();
    const before = f.sent.filter((request) => request.t === 'sub').length;
    await act(async () => {
      release.resolve();
      await f.completed.promise;
    });
    assert.equal(f.sent.filter((request) => request.t === 'sub').length, before);
    const result = await f.client.read({ children: '/items' });
    assert.equal(result.list.length, 2);
    assert.ok(result.copies.some((copy) => 'node' in copy && copy.node.$path === '/items/z'));
  });

  it('shows external additions through the refresh control and reopening the same address', async (t) => {
    const f = await fixture('browser-list-manual');
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: '/items/z', $type: 't.dir' } }],
    });
    assert.equal((await f.client.read({ children: '/items' })).list.length, 2);
    assert.equal(
      f.source.getSnapshot({ children: '/items', window: { limit: 100 } }).members.length,
      1,
    );
    await act(async () => {
      fireEvent.click(browser.getByRole('button', { name: 'Обновить список' }));
      await until(f.source, '/items', 2);
    });
    assert.ok(browser.getByRole('button', { name: '/items/z' }));
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: '/items/zz', $type: 't.dir' } }],
    });
    assert.equal((await f.client.read({ children: '/items' })).list.length, 3);
    await act(async () => {
      open(browser, '/items');
      await until(f.source, '/items', 3);
    });
    assert.ok(browser.getByRole('button', { name: '/items/zz' }));
    assert.equal(browser.queryByRole('alert'), null);
  });

  it('shows a local refresh error when its source is closed without throwing from the user control', async (t) => {
    const f = await fixture('browser-list-source-closed');
    t.after(f.close);
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper });
    open(browser, '/items');
    await act(async () => {
      await until(f.source, '/items', 1);
    });
    act(() => {
      f.source.close();
    });
    const before = browser.getAllByRole('alert').length;
    fireEvent.click(browser.getByRole('button', { name: 'Обновить список' }));
    assert.equal(browser.getAllByRole('alert').length, before + 1);
    assert.ok(
      browser.getAllByRole('alert').every((alert) => alert.textContent?.startsWith('CANCELLED:')),
    );
  });
});
