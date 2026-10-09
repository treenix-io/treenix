import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createTwpClient } from '@treenx/core/client/twp'
import { KernelError } from '@treenx/core/errors'
import { R, W, type Connection, type ModuleManifest, type Position, type Request } from '@treenx/core/kernel/types'
import { createInstanceFoundation } from '../../../../core/src/kernel/instance'
import { createMemoryStore } from '../../../../core/src/kernel/store/memory'
import { NativeTreeBrowser } from '#native/NativeEditor'
import { createNativeTreeSource, type NativeSnapshot, type NativeTreeSource } from '#tree/native-source'
import { NativeSourceProvider } from '#tree/native-source-context'

/** Waits for an actual source publication without delaying the event loop. */
function until(source: NativeTreeSource, predicate: (snapshot: NativeSnapshot) => boolean): Promise<void> {
  const selector = { node: '/document' }
  if (predicate(source.getSnapshot(selector))) return Promise.resolve()

  return new Promise(resolve => {
    const unsubscribe = source.subscribe(selector, () => {
      if (predicate(source.getSnapshot(selector))) { unsubscribe(); resolve() }
    })
  })
}

/** Opens the production admitted lane, client, and source with either public R or admin rights. */
async function fixture(id: string, administrator: boolean) {
  let complete: (args: unknown) => void = () => {};
  const invoked = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  const module: ModuleManifest = {
    id: 'native-editor-actions',
    types: [
      {
        name: 'editor.document',
        module: 'native-editor-actions',
        security: 'ordinary',
        version: 0,
        schema: {},
        actions: {
          inspect: {
            kind: 'read',
            args: {},
            handler: async (_context, args) => {
              complete(args);
              return args;
            },
          },
        },
      },
    ],
    security: [],
    open: [],
  };
  const root = createMemoryStore({ domain: id });
  let saved: Position | undefined;
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
    firstAdmin: { path: '/admin', name: 'admin', password: 'native-editor-password' },
    initialCredential: { ttlMs: 60_000 },
  });
  assert.ok(instance.setupCredential);
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential));
  await admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'install' },
    changes: [
      {
        op: 'put',
        node: {
          $path: '/sys/types/editor.document',
          $type: 't.type',
          name: 'editor.document',
          module: module.id,
          security: 'ordinary',
        },
      },
    ],
  });
  instance.registry.publish(module);
  await admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'seed' },
    changes: [
      {
        op: 'put',
        node: {
          $path: '/document',
          $type: 'editor.document',
          value: 1,
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
    ],
  });
  const lane = await instance.openSession(administrator ? instance.setupCredential : undefined);
  const sent: Request[] = [];
  const connection: Connection = {
    frames: lane.frames,
    send(request) {
      sent.push(request);
      if (request.t === 'hi')
        throw new KernelError('UNAVAILABLE', 'The admitted loopback is already open');
      if (request.t === 'read') {
        if ('history' in request.selector)
          throw new KernelError('UNAVAILABLE', 'History reads are unavailable on this lane');
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
    source,
    sent,
    invoked,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(NativeSourceProvider, { source, children }),
    /** Releases the native editor fixture's owned resources. */
    async close() {
      cleanup();
      source.close();
      client.close();
      admin.close();
      await instance.close();
    },
  };
}

describe('native editor action invocation', { timeout: 10_000 }, () => {
  it('invokes a real read action from an R-only node without exposing JSON save', async t => {
    const f = await fixture('native-editor-read-action', false)
    t.after(f.close)
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper })
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '/document' } })
    fireEvent.click(browser.getByRole('button', { name: 'Открыть' }))
    await act(async () => { await until(f.source, snapshot => snapshot.phase === 'ready') })

    const copy = f.source.getSnapshot({ node: '/document' }).members[0]
    assert.ok('node' in copy)
    assert.equal(copy.bits, R)
    assert.equal(browser.queryByLabelText('Данные узла'), null)
    assert.equal(browser.queryByRole('button', { name: 'Сохранить' }), null)
    fireEvent.change(browser.getByLabelText('Действие'), { target: { value: 'inspect' } })
    fireEvent.change(browser.getByLabelText('Аргументы JSON'), { target: { value: '{"ticket":"read-only"}' } })
    await act(async () => {
      fireEvent.click(browser.getByRole('button', { name: 'Выполнить' }))
      assert.deepEqual(await f.invoked, { ticket: 'read-only' })
    })

    const request = f.sent.find(request => request.t === 'act')
    assert.ok(request?.t === 'act')
    assert.equal(request.path, '/document')
    assert.equal(request.action, 'inspect')
    assert.deepEqual(request.args, { ticket: 'read-only' })
    assert.equal(browser.queryByRole('alert'), null)
  })

  it('preserves the editable JSON form and action form for a writer', async t => {
    const f = await fixture('native-editor-write-action', true)
    t.after(f.close)
    const browser = render(createElement(NativeTreeBrowser), { wrapper: f.wrapper })
    fireEvent.change(browser.getByLabelText('Адрес'), { target: { value: '/document' } })
    fireEvent.click(browser.getByRole('button', { name: 'Открыть' }))
    await act(async () => { await until(f.source, snapshot => snapshot.phase === 'ready') })

    const copy = f.source.getSnapshot({ node: '/document' }).members[0]
    assert.ok('node' in copy)
    assert.ok((copy.bits & W) !== 0)
    assert.ok(browser.getByLabelText('Действие'))
    const editor = browser.getByLabelText('Данные узла')
    assert.ok(editor instanceof window.HTMLTextAreaElement)
    const changed = JSON.parse(editor.value)
    changed.value = 9
    fireEvent.change(editor, { target: { value: JSON.stringify(changed) } })
    await act(async () => {
      fireEvent.click(browser.getByRole('button', { name: 'Сохранить' }))
      await until(f.source, snapshot => snapshot.members.some(copy => 'node' in copy && copy.node.value === 9))
    })

    assert.equal(browser.queryByRole('alert'), null)
    assert.ok(f.sent.some(request => request.t === 'commit'))
    assert.equal(browser.getByLabelText('Текущее состояние').textContent?.includes('"value": 9'), true)
  })
})
