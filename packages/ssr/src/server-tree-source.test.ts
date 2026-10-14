import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { KernelError } from '@treenx/core/errors';
import { R } from '@treenx/core/kernel/types';
import { ServerTreeSource } from '#server-tree-source';
import { nativeFixture } from '#native-fixture.test';
import { ssrHandler } from '#handler';
import { RouteIndex, fetchRouteNodes } from '#route-index';

it('renders credential-specific native reads and retains exact selectors/results for hydration', async (t) => {
  const { instance, admin, key } = await nativeFixture(t);
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/public',
          $type: 't.dir',
          title: 'visible',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      { op: 'put', node: { $path: '/private', $type: 't.dir', title: 'secret' } },
    ],
  });
  const anonymous = instance.commands(await instance.auth.openCredential());
  t.after(() => anonymous.close());
  const source = new ServerTreeSource(anonymous);
  assert.equal(source.getPathSnapshot('/public').status, 'loading');
  await source.flushPending();
  assert.equal(source.getPathSnapshot('/public').data?.title, 'visible');
  const hidden = new ServerTreeSource(anonymous);
  hidden.getPathSnapshot('/private');
  await assert.rejects(
    hidden.flushPending(),
    (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
  );
  const snapshot = source.serialize();
  assert.equal(snapshot.reads.length, 1);
  assert.deepEqual(snapshot.reads[0].selector, { node: '/public' });
  assert.equal(snapshot.reads[0].result.copies.length, 1);
  const html = renderToString(
    createElement('main', null, String(source.getPathSnapshot('/public').data?.title)),
  );
  assert.ok(html.includes('visible'));
  const privileged = new ServerTreeSource(admin);
  privileged.getPathSnapshot('/private');
  await privileged.flushPending();
  assert.equal(privileged.getPathSnapshot('/private').data?.title, 'secret');
});

it('preserves native include membership and propagates an actual read budget refusal', async (t) => {
  const { admin, key } = await nativeFixture(t);
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/target', $type: 't.dir', body: 'x'.repeat(10_000) } },
      { op: 'put', node: { $path: '/route', $type: 't.ref', $ref: '/target' } },
    ],
  });
  const source = new ServerTreeSource(admin);
  const handle = source.mountSelector({ node: '/route', include: [{ ref: '$ref' }] });
  await source.flushPending();
  assert.equal(handle.getSnapshot().members.length, 1);
  assert.equal(handle.getSnapshot().included.length, 1);
  assert.equal(source.serialize().reads[0].result.copies.length, 2);
  await admin.commit({
    opId: key(),
    changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { readBytes: 4096 } } }],
  });
  const bounded = new ServerTreeSource(admin);
  bounded.getPathSnapshot('/target');
  await assert.rejects(
    bounded.flushPending(),
    (error) => error instanceof KernelError && error.code === 'BUDGET',
  );
  assert.throws(
    () => bounded.serialize(),
    (error) => error instanceof KernelError && error.code === 'INVALID',
  );
});

it('renders native route data with actual hydration reads and private cache policy', async (t) => {
  const { admin, key } = await nativeFixture(t);
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/sys/routes', $type: 't.dir' } },
      {
        op: 'put',
        node: {
          $path: '/sys/routes/private',
          $type: 't.dir',
          title: 'private-page',
          '#site': { $type: 't.site', state: 'published', mode: 'hydrate' },
        },
      },
    ],
  });
  const routes = new RouteIndex();
  routes.hydrate(await fetchRouteNodes(admin));
  const result = await ssrHandler(
    { pathname: '/private', query: new URLSearchParams(), isAdmin: true, private: true },
    {
      routes,
      reader: admin,
      render({ source }) {
        const snapshot = source.getPathSnapshot('/sys/routes/private');
        return renderToString(
          createElement(
            'main',
            null,
            snapshot.status === 'loading' ? 'loading' : String(snapshot.data?.title),
          ),
        );
      },
    },
  );
  assert.ok(result);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.ok(result.bodyContent.includes('private-page'));
  assert.equal(result.initialState.reads.length, 1);
  assert.equal(result.initialState.reads[0].result.copies.length, 1);
  assert.ok(result.body.includes('treenix-initial'));
});
