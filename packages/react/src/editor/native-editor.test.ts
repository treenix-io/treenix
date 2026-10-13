import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode, useState } from 'react';
import { createTwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import {
  A,
  R,
  W,
  type Connection,
  type ModuleManifest,
  type Position,
  type Request,
} from '@treenx/core/kernel/types';
import { createInstanceFoundation } from '../../../../core/src/kernel/instance';
import { createMemoryStore } from '../../../../core/src/kernel/store/memory';
import { Render, RenderContext } from '#context';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerTreeSource } from '@treenx/ssr/server-tree-source';
import { ServerLocationContext } from '#navigate';
import { RouteParamsContext } from '#context/route-params';
import { clientModules as todoClientModules } from '../../../../mods/todo/client';
import { TodoItem } from '../../../../mods/todo/types';
import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import { clientModules as siteModules } from '../../../../mods/view-shell/view-site';
import { createClientRegistry, publishClientExports, type ClientRegistry } from '#context/client-registry';
import { unregister } from '@treenx/core';
import { clientModules } from '../mods/clients';
import { PUBLICATION_PREFIX } from '@treenx/core/kernel/uix-publication';
import { collectModule } from '@treenx/core/kernel/manifest';
import { loadSchemasRecursive } from '../../../../core/src/schema/load';
import { fileURLToPath } from 'node:url';
import { moveBefore } from '#editor/native-tree-mutations';
import { NodeEditor } from '#editor/NodeEditor';
import { usePath } from '#hooks';
import type { Node } from '@treenx/core/kernel/types';
import { createLaneTreeSource } from '#tree/lane-source';
import { TreeSourceProvider } from '#tree/tree-source-context';
import type { PathSnapshot } from '#tree/tree-source';
import { TooltipProvider } from '#components/ui/tooltip';

publishClientExports({ clientModules });

/** Wait for an actual public path publication. */
function until(
  source: ReturnType<typeof createLaneTreeSource>,
  predicate: (snapshot: PathSnapshot) => boolean,
  path = '/document',
): Promise<void> {
  if (predicate(source.getPathSnapshot(path))) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = source.subscribePath(path, () => {
      if (predicate(source.getPathSnapshot(path))) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/** Opens the production admitted lane, client, and source with either public R or admin rights. */
async function fixture(
  id: string,
  administrator: boolean,
  holdCommit?: { started: (request: Request) => void; release: Promise<void> },
  registry?: ClientRegistry,
) {
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
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          additionalProperties: false,
        },
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
  const counter = {
    async load() {
      return saved;
    },
    async save(pos: Position) {
      saved = pos;
    },
    async freshEpoch(floor: number) {
      return floor + 1;
    },
  };
  const instance = await createInstanceFoundation({
    id,
    root,
    writerEpoch: 1,
    counter,
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
          $acl: [{ subject: { group: 'public' }, grant: R }],
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
          $owner: 'u:retained-owner',
          $acl: [{ subject: { group: 'public' }, grant: R | W }],
        },
      },
    ],
  });
  const lane = await instance.openSession(administrator ? instance.setupCredential : undefined);
  const sent: Request[] = [];
  let held = false;
  const connection: Connection = {
    frames: lane.frames,
    send(request) {
      sent.push(request);
      if ((request.t === 'commit' || request.t === 'act') && holdCommit !== undefined && !held) {
        held = true;
        holdCommit.started(request);
        void holdCommit.release.then(() => lane.accept(request));
        return;
      }
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
  const source = createLaneTreeSource(client, undefined, registry);

  return {
    source,
    admin,
    instance,
    client,
    root,
    counter,
    module,
    sent,
    invoked,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(TreeSourceProvider, { source,
        children: createElement(TooltipProvider, { children }) }),
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

/** Render the public editor on actual selected canonical node coverage. */
function PublicEditor() {
  const { data: node } = usePath<Node>('/document');
  return node === undefined ? null : createElement(NodeEditor, { node, open: true, onClose() {} });
}

describe('public canonical editor', { timeout: 10_000 }, () => {
  it('uses declared todo predictions and defaults on the native source without sharing presentation', async t => {
    publishClientExports({ clientModules: todoClientModules });
    const todo = await collectModule('@treenx/mods/todo', async () => {
      await import('../../../../mods/todo/kernel');
      loadSchemasRecursive(fileURLToPath(new URL('../../../../mods/todo/', import.meta.url)));
    });
    let release: () => void = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let started: (request: Request) => void = () => {};
    const paused = new Promise<Request>(resolve => { started = resolve; });
    const f = await fixture('declared-native-prediction', true, { started, release: released });
    t.after(f.close);
    t.after(release);
    const key = (nonce: string) => ({ epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce });
    await f.admin.commit({ opId: key('todo-types'), changes: todo.types.map(type => ({
      op: 'put' as const, node: { $path: `/sys/types/${type.name}`, $type: 't.type', name: type.name,
        module: type.module, security: type.security },
    })) });
    f.instance.registry.publish(todo);
    await f.admin.commit({ opId: key('todo-document'), changes: [{ op: 'put', node: {
      $path: '/todo', $type: 'todo.item', title: 'Owned todo', done: false,
    } }] });
    const other = createLaneTreeSource(f.client, undefined, createClientRegistry([
      declareOpenModule('todo-without-prediction', [], [declareClientType('todo.item', TodoItem, { noOptimistic: ['toggle'] })]),
    ]));
    t.after(() => other.close());
    const firstMount = f.source.mountPath('/todo');
    const secondMount = other.mountPath('/todo');
    t.after(() => { firstMount.dispose(); secondMount.dispose(); });
    await Promise.all([until(f.source, snap => snap.data?.done === false, '/todo'), until(other, snap => snap.data?.done === false, '/todo')]);
    const mutation = f.source.effects.execute('/todo', 'toggle');
    assert.equal((await paused).t, 'act');
    assert.equal(f.source.getPathSnapshot('/todo').data?.done, true);
    assert.equal(other.getPathSnapshot('/todo').data?.done, false);
    release();
    await mutation;
    await until(other, snap => snap.data?.done === true, '/todo');
    await f.source.effects.createNode('/created-todo', 'todo.item');
    const created = (await f.client.read({ node: '/created-todo' })).copies[0];
    assert.ok('node' in created);
    assert.equal(created.node.title, '');
    assert.equal(created.node.done, false);
  });

  it('renders declared external views through the original site shell and request-owned native reads', async t => {
    const todo = await collectModule('@treenx/mods/todo', async () => {
      await import('../../../../mods/todo/kernel');
      loadSchemasRecursive(fileURLToPath(new URL('../../../../mods/todo/', import.meta.url)));
    });
    const viewShellManifest = await collectModule('@treenx/view-shell', () => {
      loadSchemasRecursive(fileURLToPath(new URL('../../../../mods/view-shell/', import.meta.url)));
    });
    const f = await fixture('declared-native-site', false);
    t.after(f.close);
    const key = (nonce: string) => ({ epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce });
    await f.admin.commit({ opId: key('site-types'), changes: [...todo.types, ...viewShellManifest.types].map(type => ({
      op: 'put' as const, node: { $path: `/sys/types/${type.name}`, $type: 't.type', name: type.name,
        module: type.module, security: type.security },
    })) });
    f.instance.registry.publish(todo);
    f.instance.registry.publish(viewShellManifest);
    await f.admin.commit({ opId: key('site-data'), changes: [
      { op: 'put', node: { $path: '/tasks', $type: 'todo.list', title: 'Native site tasks', $acl: [{ subject: { group: 'public' }, grant: R }] } },
      { op: 'put', node: { $path: '/tasks/first', $type: 'todo.item', title: 'Original todo row', done: false } },
      { op: 'put', node: { $path: '/sys/routes/v', $type: 't.view.shell', $acl: [{ subject: { group: 'public' }, grant: R }] } },
    ] });
    const shell = (await f.client.read({ node: '/sys/routes/v' })).copies[0];
    assert.ok('node' in shell);
    const source = new ServerTreeSource(f.client);
    const registry = createClientRegistry([...todoClientModules, ...siteModules]);
    const tree = createElement(TreeSourceProvider, { source, registry,
      children: createElement(ServerLocationContext.Provider, { value: { pathname: '/v/tasks', search: '', href: '/v/tasks' },
        children: createElement(RouteParamsContext.Provider, { value: { rest: 'tasks', full: '/v/tasks' },
          children: createElement(RenderContext, { name: 'site', children: createElement(Render, { value: shell.node }) }) }) }) });
    let html = renderToStaticMarkup(tree);
    while (source.pendingCount() > 0) {
      await source.flushPending();
      html = renderToStaticMarkup(tree);
    }
    assert.ok(html.includes('Native site tasks'));
    assert.ok(html.includes('Original todo row'));
    assert.ok(html.includes('What needs to be done?'));
  });

  it('renders native source-owned modules independently and republishes without resetting local state', async t => {
    function OwnedView({ value, label }: { value: Node; label?: string }) {
      const [count, setCount] = useState(0);
      return createElement('button', { onClick: () => setCount(count + 1) },
        `${label}:${value.value}:${count}`);
    }
    const module = (label: string) => ({ id: 'document-view', open: [{
      type: 'editor.document', context: 'react', handler: OwnedView, meta: { props: { label } },
    }] });
    const firstRegistry = createClientRegistry([module('first')]);
    const secondRegistry = createClientRegistry([module('second')]);
    const first = await fixture('client-module-first', false, undefined, firstRegistry);
    const second = await fixture('client-module-second', false, undefined, secondRegistry);
    t.after(first.close);
    t.after(second.close);
    function Document() {
      const { data } = usePath<Node>('/document');
      return data === undefined ? null : createElement(Render, { value: data });
    }
    const ui = render(createElement('div', null,
      createElement(TreeSourceProvider, { source: first.source, registry: firstRegistry,
        children: createElement(Document) }),
      createElement(TreeSourceProvider, { source: second.source, registry: secondRegistry,
        children: createElement(Document) })));
    await act(async () => {
      await Promise.all([until(first.source, snapshot => snapshot.data !== undefined),
        until(second.source, snapshot => snapshot.data !== undefined)]);
    });
    fireEvent.click(ui.getByText('first:1:0'));
    assert.ok(ui.getByText('first:1:1'));
    assert.ok(ui.getByText('second:1:0'));
    await act(async () => { firstRegistry.publish(module('republished')); });
    assert.ok(ui.getByText('republished:1:1'));
    assert.ok(ui.getByText('second:1:0'));
  });

  it('calls an interface-only action through the public typed path hook', async (t) => {
    class Document {
      static $type = 'editor.document';
      value = 0;
    }
    interface Document {
      inspect(data: { message: string }): Promise<{ message: string }>;
    }

    const f = await fixture('typed-native-hook', false);
    t.after(f.close);
    let accepted!: (value: { message: string }) => void;
    let refused!: (error: unknown) => void;
    const result = new Promise<{ message: string }>((resolve, reject) => {
      accepted = resolve;
      refused = reject;
    });

    /** Exercise the action through the same typed hook used by existing views. */
    function Probe() {
      const { data, loading } = usePath('/document', Document);
      return createElement('button', {
        disabled: loading,
        onClick: () => data!.inspect({ message: 'native owner' }).then(accepted, refused),
      }, 'Inspect native action');
    }

    const ui = render(createElement(Probe), { wrapper: f.wrapper });
    await act(() => until(f.source, snapshot => snapshot.data !== undefined));
    await act(async () => {
      fireEvent.click(ui.getByText('Inspect native action'));
      assert.deepEqual(await result, { message: 'native owner' });
    });
    assert.deepEqual(await f.invoked, { message: 'native owner' });
  });

  it('saves a full put with the loaded revision while preserving hidden ACL and owner', async (t) => {
    const f = await fixture('public-editor-hidden-admin', false);
    t.after(f.close);
    const ui = render(createElement(PublicEditor), { wrapper: f.wrapper });
    await act(async () => {
      await until(f.source, (snap) => snap.data !== undefined);
    });
    assert.equal(ui.queryByLabelText('Access control'), null);
    fireEvent.mouseDown(ui.getByRole('tab', { name: 'JSON' }), { button: 0, ctrlKey: false });
    const textarea = ui.getByRole('textbox');
    assert.ok(textarea instanceof window.HTMLTextAreaElement);
    const value: Node = JSON.parse(textarea.value);
    const loadedRev = value.$rev;
    assert.equal(value.$owner, undefined);
    assert.equal(value.$acl, undefined);
    fireEvent.change(textarea, { target: { value: JSON.stringify({ ...value, value: 9 }) } });
    await act(async () => {
      fireEvent.click(ui.getByRole('button', { name: 'Save JSON' }));
      await until(f.source, (snap) => snap.data?.value === 9);
    });
    const request = f.sent.find((request) => request.t === 'commit');
    assert.ok(request?.t === 'commit');
    assert.deepEqual(request.expect, { nodes: [{ path: '/document', rev: loadedRev }] });
    const change = request.changes[0];
    assert.ok(change.op === 'put');
    assert.equal(change.node.$id, undefined);
    assert.equal(change.node.$rev, undefined);
    assert.equal(change.node.$pos, undefined);
    const stored = await f.admin.read({ node: '/document' });
    const copy = stored.copies[0];
    assert.ok('node' in copy);
    assert.equal(copy.node.value, 9);
    assert.equal(copy.node.$owner, 'u:retained-owner');
    assert.deepEqual(copy.node.$acl, [{ subject: { group: 'public' }, grant: R | W }]);
    assert.equal(ui.queryByRole('alert'), null);
  });
  it('edits the native schema through declared number widgets and saves the original node', async t => {
    const f = await fixture('declared-native-number-form', false);
    t.after(f.close);
    const ui = render(createElement(PublicEditor), { wrapper: f.wrapper });
    const input = await ui.findByRole('spinbutton');
    fireEvent.change(input, { target: { value: '7' } });
    await act(async () => {
      fireEvent.click(ui.getByRole('button', { name: 'Save' }));
      await until(f.source, snapshot => snapshot.data?.value === 7);
    });
    const stored = (await f.admin.read({ node: '/document' })).copies[0];
    assert.ok('node' in stored);
    assert.equal(stored.node.value, 7);
    assert.equal(stored.node.$owner, 'u:retained-owner');
    assert.deepEqual(stored.node.$acl, [{ subject: { group: 'public' }, grant: R | W }]);
  });
  it('retains the stale full-node draft when the expected native revision conflicts', async (t) => {
    const f = await fixture('public-editor-stale-draft', false);
    t.after(f.close);
    const ui = render(createElement(PublicEditor), { wrapper: f.wrapper });
    await act(async () => {
      await until(f.source, (snap) => snap.data !== undefined);
    });
    fireEvent.click(ui.getByRole('button', { name: 'JSON' }));
    const textarea = ui.getByRole('textbox');
    assert.ok(textarea instanceof window.HTMLTextAreaElement);
    const value: Node = JSON.parse(textarea.value);
    const draft = JSON.stringify({ ...value, value: 9 });
    fireEvent.change(textarea, { target: { value: draft } });
    await act(async () => {
      await f.admin.commit({
        opId: { epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce: 'foreign-edit' },
        changes: [{ op: 'patch', path: '/document', ops: { $set: { value: 2 } } }],
      });
      await until(f.source, (snap) => snap.data?.value === 2);
    });
    const currentCopy = f.source.getPathSnapshot('/document').data;
    assert.ok(currentCopy);
    const editedDraft = JSON.stringify({ ...value, $rev: currentCopy.$rev, value: 9 });
    fireEvent.change(textarea, { target: { value: editedDraft } });
    const refused = new Promise<void>((resolve) => {
      const observer = new window.MutationObserver(() => {
        if (ui.queryByRole('alert') !== null) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(ui.container, { childList: true, subtree: true });
    });
    await act(async () => {
      fireEvent.click(ui.getByRole('button', { name: 'Save node' }));
    });
    await refused;
    assert.equal(ui.getByRole('alert').getAttribute('data-error-code'), 'CONFLICT');
    assert.equal(textarea.value, editedDraft);
    const stored = await f.admin.read({ node: '/document' });
    assert.ok('node' in stored.copies[0]);
    assert.equal(stored.copies[0].node.value, 2);
  });

  it('keeps reset and a second save closed while the actual first commit is paused', async (t) => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (request: Request) => void = () => {};
    const paused = new Promise<Request>((resolve) => {
      started = resolve;
    });
    const f = await fixture('public-editor-paused-save', false, { started, release: released });
    t.after(f.close);
    t.after(release);
    const ui = render(createElement(PublicEditor), { wrapper: f.wrapper });
    await act(async () => {
      await until(f.source, (snap) => snap.data !== undefined);
    });
    fireEvent.click(ui.getByRole('button', { name: 'JSON' }));
    const textarea = ui.getByRole('textbox');
    assert.ok(textarea instanceof window.HTMLTextAreaElement);
    const value: Node = JSON.parse(textarea.value);
    const draft = JSON.stringify({ ...value, value: 9 });
    fireEvent.change(textarea, { target: { value: draft } });
    await act(async () => {
      fireEvent.click(ui.getByRole('button', { name: 'Save node' }));
      await paused;
    });
    const reset = ui.getByRole('button', { name: 'Reset' });
    const save = ui.getByRole('button', { name: 'Save node' });
    assert.ok(reset instanceof window.HTMLButtonElement);
    assert.ok(save instanceof window.HTMLButtonElement);
    assert.equal(reset.disabled, true);
    assert.equal(save.disabled, true);
    assert.equal(textarea.closest('fieldset')?.disabled, true);
    fireEvent.click(reset);
    fireEvent.click(save);
    assert.equal(textarea.value, draft);
    assert.equal(f.sent.filter((request) => request.t === 'commit').length, 1);
    await act(async () => {
      release();
      await until(f.source, (snap) => snap.data?.value === 9);
    });
    assert.equal(reset.disabled, false);
    assert.equal(f.sent.filter((request) => request.t === 'commit').length, 1);
    fireEvent.click(ui.getByRole('button', { name: 'JSON' }));
    const nextTextarea = ui.getByRole('textbox');
    assert.ok(nextTextarea instanceof window.HTMLTextAreaElement);
    const accepted: Node = JSON.parse(nextTextarea.value);
    fireEvent.change(nextTextarea, {
      target: { value: JSON.stringify({ ...accepted, value: 10 }) },
    });
    await act(async () => {
      fireEvent.click(save);
      await until(f.source, (snap) => snap.data?.value === 10);
    });
    assert.equal(f.sent.filter((request) => request.t === 'commit').length, 2);
  });

  it('exposes administration controls only with actual A and reads full metadata through the real read action', async (t) => {
    const f = await fixture('public-editor-described-admin', true);
    t.after(f.close);
    const ui = render(createElement(PublicEditor), { wrapper: f.wrapper });
    await act(async () => {
      await until(f.source, (snap) => snap.data !== undefined);
    });
    assert.ok(ui.getByLabelText('Access control'));
    assert.equal(f.source.effects.bits('/document'), R | W | A);
    const description = await f.source.effects.execute(
      '/sys/types/editor.document',
      'describe_type',
      {},
      't.type',
    );
    assert.equal(description.name, 'editor.document');
    assert.deepEqual(description.schema, {
      type: 'object',
      properties: { value: { type: 'number' } },
      additionalProperties: false,
    });
    assert.equal(description.actions.inspect.kind, 'read');
    assert.equal('handler' in description.actions.inspect, false);
    assert.equal('handler' in description, false);
  });

  it('refuses schema introspection when current R is absent', async (t) => {
    const f = await fixture('public-editor-description-no-read', false);
    t.after(f.close);
    await f.admin.commit({
      opId: { epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce: 'hide-type' },
      changes: [
        {
          op: 'patch',
          path: '/sys/types/editor.document',
          ops: { $set: { $acl: [{ subject: { group: 'public' }, deny: R }] } },
        },
      ],
    });
    await assert.rejects(
      f.source.effects.execute('/sys/types/editor.document', 'describe_type', {}, 't.type'),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
  });

  it('uses actual move/remove members and fractional order under source-owned native commits', async (t) => {
    const f = await fixture('public-editor-tree-members', true);
    t.after(f.close);
    await f.admin.commit({
      opId: { epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce: 'tree-seed' },
      changes: [
        {
          op: 'put',
          node: {
            $path: '/folder',
            $type: 't.dir',
            $acl: [{ subject: { group: 'public' }, grant: R | W }],
          },
        },
        {
          op: 'put',
          node: { $path: '/folder/reference', $type: 'editor.document', value: 2, $order: 'M' },
        },
      ],
    });
    const fromRead = await f.client.read({ node: '/document' });
    const toRead = await f.client.read({ children: '/folder', sort: [['$order', 1]] });
    const fromCopy = fromRead.copies[0];
    assert.ok('node' in fromCopy);
    const siblings = toRead.copies.map((copy) => {
      assert.ok('node' in copy);
      return copy.node;
    });
    const kernel = f.source.effects.kernel;
    assert.ok(kernel);
    await kernel.commit(moveBefore(fromCopy.node, siblings[0], siblings, true));
    const ordered = await f.client.read({ children: '/folder', sort: [['$order', 1]] });
    const paths = ordered.list.map((id) => {
      const copy = ordered.copies.find((copy) => 'node' in copy && copy.node.$id === id);
      assert.ok(copy && 'node' in copy);
      return copy.node.$path;
    });
    assert.deepEqual(paths, ['/folder/document', '/folder/reference']);
    const moved = ordered.copies.find(
      (copy) => 'node' in copy && copy.node.$path === '/folder/document',
    );
    assert.ok(moved && 'node' in moved);
    assert.equal(moved.node.$id, fromCopy.node.$id);
    assert.ok(moved.node.$order !== undefined && moved.node.$order < 'M');
    await kernel.commit({
      changes: [{ op: 'remove', path: moved.node.$path }],
      expect: { nodes: [{ path: moved.node.$path, rev: moved.node.$rev }] },
    });
    await assert.rejects(
      f.client.read({ node: '/folder/document' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.ok(
      f.sent.some(
        (request) =>
          request.t === 'commit' && request.changes.some((change) => change.op === 'move'),
      ),
    );
    assert.ok(
      f.sent.some(
        (request) =>
          request.t === 'commit' && request.changes.some((change) => change.op === 'remove'),
      ),
    );
  });

  it('owns and releases a real native type-ownership subscription without publishing draft code', async (t) => {
    const f = await fixture('public-editor-uix-type-coverage', false);
    t.after(f.close);
    t.after(() => unregister('editor.document', 'react'));
    const body = await f.client.read({ node: '/document' });
    const copy = body.copies[0];
    assert.ok('node' in copy);
    const ready = new Promise<void>((resolve) => {
      const unsubscribe = f.source.subscribePath('/sys/types/editor.document', () => {
        if (f.source.getPathSnapshot('/sys/types/editor.document').data !== undefined) {
          unsubscribe();
          resolve();
        }
      });
    });
    const ui = render(createElement(Render, { value: copy.node }), { wrapper: f.wrapper });
    await act(async () => {
      await ready;
    });
    const subscription = f.sent.find(
      (request) =>
        request.t === 'sub' &&
        'node' in request.selector &&
        request.selector.node === '/sys/types/editor.document',
    );
    assert.ok(subscription?.t === 'sub');
    assert.equal(
      f.source.getPathSnapshot('/sys/types/editor.document').data?.name,
      'editor.document',
    );
    ui.unmount();
    assert.ok(f.sent.some((request) => request.t === 'unsub' && request.sub === subscription.sub));
  });

  it('keeps writable drafts inactive until an admin publishes a protected live generation', async (t) => {
    const uixManifest = await collectModule('@treenx/react/uix', async () => {
      await import('../mods/uix/kernel');
      loadSchemasRecursive(fileURLToPath(new URL('../mods/uix/', import.meta.url)));
    });
    const f = await fixture('public-editor-admin-publication', false);
    t.after(f.close);
    t.after(() => unregister('editor.document', 'react'));
    let ordinal = 0;
    const key = () => ({
      epoch: f.instance.writer.intake.epoch,
      time: Date.now(),
      nonce: `publication-${ordinal++}`,
    });
    await f.admin.commit({
      opId: key(),
      changes: uixManifest.types.map((type) => ({
        op: 'put' as const,
        node: {
          $path: `/sys/types/${type.name}`,
          $type: 't.type',
          name: type.name,
          module: type.module,
          security: type.security,
        },
      })),
    });
    f.instance.registry.publish(uixManifest);
    await f.admin.commit({
      opId: key(),
      changes: [
        {
          op: 'put',
          node: {
            $path: '/draft',
            $type: 'uix.source',
            source: '',
            $acl: [{ subject: { group: 'public' }, grant: R | W }],
          },
        },
        {
          op: 'put',
          node: {
            $path: '/uix-tools',
            $type: 'uix.mcp',
            $acl: [{ subject: { group: 'public' }, grant: R | W }],
          },
        },
      ],
    });
    const digest = f.instance.registry.digest;
    const one = 'export default function View() { return <p>Published one</p>; }';
    const saved = await f.client.act({
      path: '/uix-tools',
      action: 'compile_view',
      args: { path: '/draft', source: one },
      opId: f.client.key(),
    }).outcome;
    assert.deepEqual(saved.value, { ok: true, saved: '/draft' });
    assert.equal(f.instance.registry.digest, digest);
    await f.client.commit({
      opId: f.client.key(),
      changes: [
        {
          op: 'put',
          node: {
            $path: '/draft',
            $type: 'uix.source',
            source: one,
            published: { source: 'forged' },
          },
        },
      ],
    }).outcome;
    assert.equal(f.instance.registry.digest, digest);
    await assert.rejects(
      f.client.act({
        path: '/sys/types/editor.document',
        action: 'publish_view',
        args: { draft: '/draft' },
        opId: f.client.key(),
      }).outcome,
      (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    const body = await f.client.read({ node: '/document' });
    const copy = body.copies[0];
    assert.ok('node' in copy);
    const ui = render(createElement(Render, { value: copy.node }), { wrapper: f.wrapper });
    await act(async () => {
      await f.admin.act({
        path: '/sys/types/editor.document',
        action: 'publish_view',
        args: { draft: '/draft' },
        opId: key(),
      });
    });
    await ui.findByText('Published one');
    assert.notEqual(f.instance.registry.digest, digest);
    const accepted = f.instance.registry.module('native-editor-actions').views?.['editor.document'];
    assert.equal(accepted?.source, one);
    assert.ok(accepted);
    await assert.rejects(
      f.client.commit({
        opId: f.client.key(),
        changes: [
          {
            op: 'put',
            node: {
              $path: `${PUBLICATION_PREFIX}editor.document`,
              $type: 'uix.publication',
              ...accepted,
              source: 'forged',
            },
          },
        ],
      }).outcome,
      (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    const two = 'export default function View() { return <p>Published two</p>; }';
    await act(async () => {
      await f.client.commit({
        opId: f.client.key(),
        changes: [{ op: 'put', node: { $path: '/draft', $type: 'uix.source', source: two } }],
      }).outcome;
    });
    assert.ok(ui.getByText('Published one'));
    assert.equal(ui.queryByText('Published two'), null);
    await act(async () => {
      await f.admin.act({
        path: '/sys/types/editor.document',
        action: 'publish_view',
        args: { draft: '/draft' },
        opId: key(),
      });
    });
    assert.ok(await ui.findByText('Published two'));
    assert.ok(
      f.sent.some(
        (request) =>
          request.t === 'sub' &&
          'node' in request.selector &&
          request.selector.node === '/sys/types/editor.document',
      ),
    );
    const view = f.instance.registry.module(f.module.id).views?.['editor.document'];
    await f.close();
    const reopened = await createInstanceFoundation({
      id: f.instance.id,
      root: f.root,
      counter: f.counter,
      writerEpoch: 2,
      domains: [{ store: f.root, epoch: `${f.instance.id}:memory`, persistent: false }],
      initialCredential: { ttlMs: 60_000 },
    });
    t.after(() => reopened.close());
    reopened.registry.publish(f.module);
    reopened.registry.publish(uixManifest);
    assert.equal(reopened.registry.module(f.module.id).views, undefined);
    await reopened.preparePublications();
    assert.deepEqual(reopened.registry.module(f.module.id).views?.['editor.document'], view);
  });

  it('a published view uses its source and retains local state through native updates', async (t) => {
    const manifest = await collectModule('@treenx/react/uix', async () => {
      await import('../mods/uix/kernel');
      loadSchemasRecursive(fileURLToPath(new URL('../mods/uix/', import.meta.url)));
    });
    const f = await fixture('published-view-native-owner', false);
    t.after(f.close);
    t.after(() => unregister('editor.document', 'react'));
    let nonce = 0;
    const key = () => ({
      epoch: f.instance.writer.intake.epoch,
      time: Date.now(),
      nonce: `view-${nonce++}`,
    });
    await f.admin.commit({
      opId: key(),
      changes: manifest.types.map((type) => ({
        op: 'put' as const,
        node: {
          $path: `/sys/types/${type.name}`,
          $type: 't.type',
          name: type.name,
          module: type.module,
          security: type.security,
        },
      })),
    });
    f.instance.registry.publish(manifest);
    const source = `export default function View({ value }) {
      const [count, setCount] = useState(0);
      const ctx = viewCtx(value);
      return <div><p>{'Value ' + value.value}</p><p>{'Clicks ' + count}</p>
        <button onClick={async () => { await execute(ctx.path, 'inspect', { tag: 'native-view' }); setCount(c => c + 1); }}>Inspect owner</button>
      </div>;
    }`;
    await f.admin.commit({
      opId: key(),
      changes: [{ op: 'put', node: { $path: '/draft', $type: 'uix.source', source } }],
    });
    await f.admin.act({
      path: '/sys/types/editor.document',
      action: 'publish_view',
      args: { draft: '/draft' },
      opId: key(),
    });

    function Document() {
      const { data, loading, error } = usePath<Node>('/document');
      if (error !== null) throw error;
      if (loading) return null;
      if (data === undefined) throw new Error('Published document is absent');
      return createElement(Render, { value: data });
    }

    const ui = render(createElement(Document), { wrapper: f.wrapper });
    await ui.findByText('Value 1');
    await act(async () => {
      fireEvent.click(ui.getByRole('button', { name: 'Inspect owner' }));
      assert.deepEqual(await f.invoked, { tag: 'native-view' });
    });
    await ui.findByText('Clicks 1');
    await act(async () => {
      await f.admin.commit({
        opId: key(),
        changes: [{ op: 'patch', path: '/document', ops: { $set: { value: 2 } } }],
      });
      await until(f.source, (snapshot) => snapshot.data?.value === 2);
    });
    assert.ok(ui.getByText('Value 2'));
    assert.ok(ui.getByText('Clicks 1'));
  });
});
