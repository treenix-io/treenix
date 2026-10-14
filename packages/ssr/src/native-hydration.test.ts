import assert from 'node:assert/strict';
import { once } from 'node:events';
import { it } from 'node:test';
import { Window } from 'happy-dom';
import { act, createElement, useEffect, useSyncExternalStore } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { openTwpHttp } from '@treenx/core/client/http-twp';
import { createTwpClient } from '@treenx/core/client/twp';
import { createLaneTreeSource } from '@treenx/react/tree/lane-source';
import { TreeSourceProvider, useTreeSource } from '@treenx/react/tree/tree-source-context';
import { createTwpHttpServer } from '../../../core/src/server/http-twp';
import { nativeFixture } from '#native-fixture.test';
import { ServerTreeSource } from '#server-tree-source';

function Page() {
  const source = useTreeSource();
  const snapshot = useSyncExternalStore(
    (callback) => source.subscribePath('/page', callback),
    () => source.getPathSnapshot('/page'),
    () => source.getPathSnapshot('/page'),
  );
  useEffect(() => {
    const handle = source.mountPath('/page');
    return () => handle.dispose();
  }, [source]);
  return createElement(
    'main',
    null,
    snapshot.data === undefined ? 'loading' : String(snapshot.data.title),
  );
}

it('hydrates the native server projection before genuine client subscription replaces its presentation', async (t) => {
  const { instance, admin, key } = await nativeFixture(t);
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/page', $type: 't.dir', title: 'native-hydrated-page' } },
    ],
  });
  const serverSource = new ServerTreeSource(admin);
  renderToString(
    createElement(TreeSourceProvider, { source: serverSource, children: createElement(Page) }),
  );
  await serverSource.flushPending();
  const markup = renderToString(
    createElement(TreeSourceProvider, { source: serverSource, children: createElement(Page) }),
  );
  const api = createTwpHttpServer({ instance, allowedOrigins: [], credentialTtlMs: 60_000 });
  t.after(() => api.close());
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  const address = api.server.address();
  assert.ok(address !== null && typeof address === 'object');
  const connection = await openTwpHttp({
    url: `http://127.0.0.1:${address.port}`,
    credential: instance.setupCredential,
  });
  const client = createTwpClient(connection, { close: connection.close });
  t.after(() => client.close());
  await client.ready;
  const source = createLaneTreeSource(client, serverSource.serialize());
  t.after(() => source.close());
  const window = new Window();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let root: Root | undefined;
  try {
    const element = document.createElement('div');
    document.body.append(element);
    element.innerHTML = markup;
    const errors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(
        element,
        createElement(TreeSourceProvider, { source, children: createElement(Page) }),
        { onRecoverableError: (error) => errors.push(error) },
      );
    });
    await act(
      async () =>
        new Promise<void>((resolve) => {
          const ready = () => {
            if (source.getSelectorSnapshot({ node: '/page' }).generations.length === 0) return;
            unsubscribe();
            resolve();
          };
          const unsubscribe = source.subscribePath('/page', ready);
          ready();
        }),
    );
    assert.equal(element.textContent, 'native-hydrated-page');
    assert.deepEqual(errors, []);
    assert.ok(client.cache.copy(serverSource.serialize().reads[0].result.list[0]));
  } finally {
    await act(async () => root?.unmount());
    await window.happyDOM.close();
    for (const [name, descriptor] of descriptors)
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
  }
});
