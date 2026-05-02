import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  getRegisteredTypes,
  mapRegistry,
  onResolveMiss,
  resolve,
  unregister,
} from '@treenx/core';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { loadSchemaOrgV29Pack, verifySnapshotChecksum } from './pack';

function snapshotRegistry(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  mapRegistry((t, c) => { out.push([t, c]); });
  return out;
}

function restoreRegistryTo(snap: Array<[string, string]>) {
  const current = snapshotRegistry();
  const wanted = new Set(snap.map(([t, c]) => `${t}@${c}`));
  for (const [t, c] of current) {
    if (!wanted.has(`${t}@${c}`)) unregister(t, c);
  }
}

describe('loadSchemaOrgV29Pack', () => {
  let savedRegistry: Array<[string, string]>;
  let tree: Tree;

  beforeEach(() => {
    savedRegistry = snapshotRegistry();
    tree = createMemoryTree();
  });

  afterEach(() => {
    onResolveMiss('schema', () => {});
    restoreRegistryTo(savedRegistry);
  });

  it('registers no pack schemas eagerly (lazy contract)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const types = getRegisteredTypes('schema');
    assert.equal(types.includes('jsonld.schema-org.Person'), false, 'Person must NOT be registered yet — only on resolve');
    assert.equal(types.includes('jsonld.schema-org.Event'), false);
  });

  it('registers a pack schema on first resolve(type, schema) (AC21 path)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const handler = resolve('jsonld.schema-org.Person', 'schema');
    assert.ok(handler, 'sync miss resolver must return handler in same call');
    const schema = (handler as () => unknown)();
    assert.equal((schema as { $id: string }).$id, 'jsonld.schema-org.Person');
    assert.ok(getRegisteredTypes('schema').includes('jsonld.schema-org.Person'));
  });

  it('memoizes — second resolve returns same handler', async () => {
    await loadSchemaOrgV29Pack(tree);
    const first = resolve('jsonld.schema-org.Person', 'schema');
    const second = resolve('jsonld.schema-org.Person', 'schema');
    assert.equal(first, second, 'same handler reference on memoized resolve');
  });

  it('returns null for non-pack types (prefix mismatch)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const handler = resolve('some.other.type', 'schema');
    assert.equal(handler, null);
  });

  it('idempotent — running pack-load twice does not duplicate registry entries (AC20)', async () => {
    await loadSchemaOrgV29Pack(tree);
    const before = snapshotRegistry();
    await loadSchemaOrgV29Pack(tree);
    const after = snapshotRegistry();
    assert.equal(after.length, before.length, 'registry size unchanged after second load');
  });

  it('throws loud on snapshot SHA-256 mismatch (AC7)', () => {
    assert.throws(
      () => verifySnapshotChecksum('0000000000000000000000000000000000000000000000000000000000000000'),
      /checksum mismatch/i,
    );
  });
});

describe('end-to-end: validateNode through pack resolver', () => {
  let savedRegistry: Array<[string, string]>;

  beforeEach(() => { savedRegistry = snapshotRegistry(); });
  afterEach(() => {
    onResolveMiss('schema', () => {});
    restoreRegistryTo(savedRegistry);
  });

  it('first tree.set of a never-resolved pack type validates via lazy resolver (AC21)', async () => {
    const { validateNode } = await import('@treenx/core/comp/validate');
    const tree = createMemoryTree();
    await loadSchemaOrgV29Pack(tree);

    const errors = validateNode({
      $path: '/customers/alice',
      $type: 'jsonld.schema-org.Person',
      name: 'Alice',
    } as any);
    assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
  });

  it('rejects scalar type mismatch (AC9)', async () => {
    const { validateNode } = await import('@treenx/core/comp/validate');
    const tree = createMemoryTree();
    await loadSchemaOrgV29Pack(tree);

    const errors = validateNode({
      $path: '/customers/alice',
      $type: 'jsonld.schema-org.Person',
      name: 42,
    } as any);
    assert.equal(errors.length > 0, true, 'name=42 must error (string expected)');
  });

  it('rejects missing required (AC12)', async () => {
    const { validateNode } = await import('@treenx/core/comp/validate');
    const tree = createMemoryTree();
    await loadSchemaOrgV29Pack(tree);

    const errors = validateNode({
      $path: '/customers/alice',
      $type: 'jsonld.schema-org.Person',
    } as any);
    assert.equal(errors.length > 0, true, 'missing name must error');
  });
});
