import { register } from '#core';
import { clearRegistry } from '#core/index.test';
import { TypeCatalog } from '#schema/catalog';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

describe('TypeCatalog', () => {
  afterEach(() => {
    clearRegistry();
  });

  it('lists compact type, property, and action docs without inventing descriptions', () => {
    register('catalog.sample', 'schema', () => ({
      $id: 'catalog.sample',
      type: 'object',
      title: 'Sample',
      properties: {
        name: {
          type: 'string',
          title: 'Name',
          description: 'Human-readable name.',
        },
        target: {
          type: 'string',
          format: 'path',
          refType: 'catalog.target',
        },
      },
      required: ['name'],
      methods: {
        run: {
          title: 'Run sample',
          description: 'Executes the sample action.',
          arguments: [{ name: 'force', type: 'boolean' }],
        },
      },
    }));

    register('catalog.title-only', 'schema', () => ({
      $id: 'catalog.title-only',
      type: 'object',
      title: 'Title Only',
      properties: {},
    }));

    const entries = new TypeCatalog().list();
    const sample = entries.find((entry) => entry.name === 'catalog.sample');
    const titleOnly = entries.find((entry) => entry.name === 'catalog.title-only');

    assert.deepEqual(sample, {
      name: 'catalog.sample',
      title: 'Sample',
      properties: ['name', 'target'],
      actions: ['run'],
      propertyDocs: {
        name: {
          type: 'string',
          title: 'Name',
          description: 'Human-readable name.',
          required: true,
        },
        target: {
          type: 'string',
          format: 'path',
          refType: 'catalog.target',
        },
      },
      actionDocs: {
        run: {
          title: 'Run sample',
          description: 'Executes the sample action.',
          arguments: ['force: boolean'],
        },
      },
    });
    assert.equal(titleOnly?.description, undefined);
  });
});
