import assert from 'node:assert/strict';
import { it } from 'node:test';
import { validateComponent } from '@treenx/core/comp/validate';
import { planKernelUpgrade } from '@treenx/core/tools/upgrade-kernel-plan';
import { createMongoManifest } from '#native-mount';

it('splits one registered closed connection for sibling declarations without exposing its URI in mount data', () => {
  const uri = 'mongodb://127.0.0.1:27017/?replicaSet=upgrade';
  const manifest = createMongoManifest({});
  let next = 0;
  const options = {
    id: () => `connection-${++next}`,
    mongoConnections: { [uri]: { cluster: 'cluster', path: '/connection' } },
    validate(component: Readonly<Record<string, unknown>>) {
      const definition = manifest.types.find((type) => type.name === component.$type);
      if (definition === undefined) return ['UNREGISTERED_TYPE'];
      return validateComponent(component, definition.schema, '').map((error) => error.path);
    },
  };
  const original = [
    {
      path: '/left',
      body: { $id: 'left-id', $type: 't.mount.mongo', uri, db: 'left', collection: 'nodes' },
    },
    {
      path: '/right',
      body: { $id: 'right-id', $type: 't.mount.mongo', uri, db: 'right', collection: 'nodes' },
    },
  ];
  const plan = planKernelUpgrade(original, options);
  assert.deepEqual(
    plan.findings.filter((finding) => finding.severity === 'error'),
    [],
  );
  const closed = plan.documents.find((document) => document.path === '/connection');
  assert.ok(closed);
  assert.equal(closed.body.$type, 't.mongo.connection');
  assert.equal(closed.body.uri, uri);
  assert.deepEqual(closed.body.$acl, [
    { subject: { group: 'admins' }, grant: 7 },
    { subject: { group: 'n:left-id' }, grant: 1 },
    { subject: { group: 'n:right-id' }, grant: 1 },
  ]);
  for (const path of ['/left', '/right']) {
    const mount = plan.documents.find((document) => document.path === path);
    assert.ok(mount);
    assert.equal('uri' in mount.body, false);
    assert.equal(mount.body.cluster, 'cluster');
  }
  const repeated = planKernelUpgrade(plan.documents, options);
  assert.deepEqual(repeated.documents, plan.documents);
  assert.deepEqual(repeated.findings, []);
});
