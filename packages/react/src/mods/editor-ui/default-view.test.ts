import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { register } from '@treenx/core';
import type { ComponentData } from '@treenx/core';
import type { TypeSchema } from '@treenx/core/schema/types';
import { Render } from '#context';
import {
  inferType,
  resolveDisplayType,
  splitRecord,
  TypedRecordView,
} from './default-view';

afterEach(() => cleanup());

describe('splitRecord', () => {
  it('respects schema order and appends ad-hoc fields once', () => {
    const schema: TypeSchema = {
      type: 'object',
      properties: {
        second: { type: 'number', title: 'Second' },
        first: { type: 'string', title: 'First' },
      },
    };
    const value: ComponentData = { $type: 'demo', first: 'a', second: 2, extra: true };

    const result = splitRecord(value, schema);

    assert.deepEqual(
      result.rest.map((field) => field.name),
      ['second', 'first', 'extra'],
    );
    assert.equal(result.rest[0].prop?.title, 'Second');
  });

  it('filters $-prefixed keys in schema and ad-hoc passes', () => {
    const schema: TypeSchema = {
      type: 'object',
      properties: {
        $schema: { type: 'string' },
        title: { type: 'string' },
      },
    };
    const value: ComponentData = {
      $type: 'demo',
      $schema: 'hidden',
      $rev: 1,
      title: 'Visible',
      body: 'shown',
    };

    const result = splitRecord(value, schema);

    assert.equal(result.title?.name, 'title');
    assert.deepEqual(
      result.rest.map((field) => field.name),
      ['body'],
    );
  });

  it('classifies typed and bare refs as plain fields', () => {
    const value: ComponentData = {
      $type: 'demo',
      typed: { $type: 'ref', $ref: '/typed' },
      bare: { $ref: '/bare' },
    };

    const result = splitRecord(value, null);

    assert.deepEqual(
      result.rest.map((field) => field.name),
      ['typed', 'bare'],
    );
    assert.deepEqual(result.components, []);
  });

  it('classifies nested typed objects as components', () => {
    const child: ComponentData = { $type: 'child', label: 'Child' };
    const value: ComponentData = { $type: 'demo', child, count: 1 };

    const result = splitRecord(value, null);

    assert.deepEqual(result.rest.map((field) => field.name), ['count']);
    assert.deepEqual(result.components, [{ name: 'child', value: child }]);
  });

  it('promotes only the first title/name/label field', () => {
    const value: ComponentData = {
      $type: 'demo',
      name: 'Primary',
      title: 'Secondary',
      label: 'Tertiary',
      description: 'ordinary row',
    };

    const result = splitRecord(value, null);

    assert.equal(result.title?.name, 'name');
    assert.deepEqual(
      result.rest.map((field) => field.name),
      ['title', 'label', 'description'],
    );
  });
});

describe('default-view helpers', () => {
  it('infers display types for untyped values', () => {
    assert.equal(inferType(['a']), 'array');
    assert.equal(inferType(null), 'string');
    assert.equal(inferType('x'), 'string');
    assert.equal(inferType(1), 'number');
    assert.equal(inferType(false), 'boolean');
    assert.equal(inferType({ a: 1 }), 'object');
  });

  it('falls back from unknown schema format to property type and inferred type', () => {
    register('string', 'react', () => null);
    register('number', 'react', () => null);

    assert.equal(resolveDisplayType({ format: 'uuid', type: 'string' }, 'x'), 'string');
    assert.equal(resolveDisplayType({ format: 'uuid', type: 'unknown' }, 1), 'number');
  });
});

describe('TypedRecordView', () => {
  it('stops recursive rendering past the depth limit', () => {
    let root: ComponentData = { $type: 'deep.leaf' };
    for (let i = 0; i < 10; i++) {
      root = { $type: `deep.${i}`, child: root };
    }

    render(createElement(TypedRecordView, { value: root }));

    assert.ok(screen.getByText('...'));
  });

  it('normalizes bare refs before rendering them through ref@react', () => {
    register('ref', 'react', ({ value }: { value: ComponentData & { $ref: string } }) =>
      createElement('span', null, `${value.$type}:${value.$ref}`),
    );

    render(createElement(Render, { value: { $type: 'demo.ref-holder', target: { $ref: '/x' } } }));

    assert.equal(screen.getByText('ref:/x').textContent, 'ref:/x');
  });
});
