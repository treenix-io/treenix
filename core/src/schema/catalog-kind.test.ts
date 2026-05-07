import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { register } from '#core';
import { clearRegistry } from '#core/index.test';
import { TypeCatalog } from '#schema/catalog';

describe('TypeCatalog — kind/io propagation', () => {
  afterEach(() => {
    clearRegistry();
  });

  it('exposes kind="read" in list() actionDocs (via summarizeAction)', () => {
    register('catalog.kind.sample', 'schema', () => ({
      $id: 'catalog.kind.sample',
      type: 'object',
      title: 'Sample',
      properties: {},
      methods: {
        getTotal: {
          title: 'Get total',
          arguments: [],
          kind: 'read' as const,
        },
      },
    }));

    const catalog = new TypeCatalog();
    const entry = catalog.list().find((e) => e.name === 'catalog.kind.sample');
    assert.equal(entry?.actionDocs?.getTotal?.kind, 'read');
  });

  it('exposes io=true in list() actionDocs (via summarizeAction)', () => {
    register('catalog.kind.io-sample', 'schema', () => ({
      $id: 'catalog.kind.io-sample',
      type: 'object',
      title: 'Sample',
      properties: {},
      methods: {
        sendEmail: {
          arguments: [],
          kind: 'write' as const,
          io: true,
        },
      },
    }));

    const catalog = new TypeCatalog();
    const entry = catalog.list().find((e) => e.name === 'catalog.kind.io-sample');
    assert.equal(entry?.actionDocs?.sendEmail?.kind, 'write');
    assert.equal(entry?.actionDocs?.sendEmail?.io, true);
  });
});
