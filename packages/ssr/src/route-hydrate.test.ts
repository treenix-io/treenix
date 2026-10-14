import assert from 'node:assert/strict';
import { it } from 'node:test';
import { nativeFixture } from '#native-fixture.test';
import { RouteIndex, fetchRouteNodes } from '#route-index';

it('discovers nested native routes through immediate-child pages', async (t) => {
  const { admin, key } = await nativeFixture(t);
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/sys/routes', $type: 't.dir' } },
      { op: 'put', node: { $path: '/sys/routes/v', $type: 't.dir' } },
      { op: 'put', node: { $path: '/sys/routes/v/admin', $type: 't.dir' } },
      { op: 'put', node: { $path: '/sys/routes/about', $type: 't.dir' } },
    ],
  });
  const nodes = await fetchRouteNodes(admin);
  assert.deepEqual(nodes.map((node) => node.$path).sort(), [
    '/sys/routes/about',
    '/sys/routes/v',
    '/sys/routes/v/admin',
  ]);
  const routes = new RouteIndex();
  routes.hydrate(nodes);
  assert.equal(routes.resolve('/v/admin')?.node.$path, '/sys/routes/v/admin');
});
