import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { register } from '@treenx/core';
import type { ComponentData, NodeData } from '@treenx/core';
import type { TypeSchema } from '@treenx/core/schema/types';
import { Render } from '#context';
import { TooltipProvider } from '#components/ui/tooltip';
import { TreeSourceProvider } from '#tree/tree-source-context';
import { EMPTY_PATH_SNAPSHOT, type ChildrenSnapshot, type TreeSource } from '#tree/tree-source';
import { makeNavigateApi, NavigateProvider } from '#navigate';
import {
  inferType,
  resolveDisplayType,
  splitRecord,
  TypedRecordView,
} from './default-view';

afterEach(() => cleanup());

describe('splitRecord', () => {
  it('respects schema order and hides undeclared plain fields (schema-strict)', () => {
    const schema: TypeSchema = {
      type: 'object',
      properties: {
        second: { type: 'number', title: 'Second' },
        first: { type: 'string', title: 'First' },
      },
    };
    const value: ComponentData = { $type: 'demo', first: 'a', second: 2, extra: true };

    const result = splitRecord(value, schema);

    // schema order (second before first); `extra` is undeclared → hidden under a schema
    assert.deepEqual(
      result.rest.map((field) => field.name),
      ['second', 'first'],
    );
    assert.equal(result.rest[0].prop?.title, 'Second');
  });

  it('filters $-prefixed keys; declared fields show, undeclared hidden', () => {
    const schema: TypeSchema = {
      type: 'object',
      properties: {
        $schema: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
    };
    const value: ComponentData = {
      $type: 'demo',
      $schema: 'hidden',
      $rev: 1,
      title: 'Visible',
      body: 'shown',
      extra: 'adhoc',
    };

    const result = splitRecord(value, schema);

    assert.equal(result.title?.name, 'title');
    // $-keys filtered ($schema/$rev), declared `body` shown, undeclared `extra` hidden
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

const noopNavigate = makeNavigateApi(() => true, () => null);

// RenderChildren consumes TreeSource + Navigate contexts — provide both statically.
function renderWithProviders(source: TreeSource, value: ComponentData) {
  return render(createElement(NavigateProvider, { value: noopNavigate },
    createElement(TreeSourceProvider, {
      source,
      children: createElement(TooltipProvider, null, createElement(TypedRecordView, { value })),
    }),
  ));
}

// Static TreeSource — serves canned children, no fetch/watch side effects.
function fakeSource(childrenByPath: Record<string, NodeData[]>): TreeSource {
  const snaps = new Map<string, ChildrenSnapshot>();
  return {
    getPathSnapshot: () => EMPTY_PATH_SNAPSHOT,
    getChildrenSnapshot: (p) => {
      let s = snaps.get(p);
      if (!s) {
        s = { data: childrenByPath[p] ?? [], phase: 'ready', total: null, truncated: null, nextCursor: null, error: null };
        snaps.set(p, s);
      }
      return s;
    },
    subscribePath: () => () => {},
    subscribeChildren: () => () => {},
    mountPath: () => ({ refetch() {}, dispose() {} }),
    mountChildren: () => ({ refetch() {}, loadMore() {}, dispose() {} }),
  };
}

describe('TypedRecordView', () => {
  // Regression core-6s1: e764b74 unified node+component views and dropped the
  // children block — untyped nodes showed fields but never their children.
  it('renders children for node values ($path present)', () => {
    const source = fakeSource({
      '/list': [
        { $path: '/list/a', $type: 'example.todo', title: 'First child' },
        { $path: '/list/b', $type: 'example.todo', title: 'Second child' },
      ],
    });
    const node: ComponentData = { $path: '/list', $type: 'example.todo.list', title: 'My list' };

    renderWithProviders(source, node);

    // DefaultListItem (react:list fallback) renders path name + type per child.
    assert.ok(screen.getByText('a'), 'first child rendered');
    assert.ok(screen.getByText('b'), 'second child rendered');
    assert.equal(screen.getAllByText('example.todo').length, 2);
    assert.ok(screen.getByText('List'), 'context switcher rendered');
  });

  it('does not render a children block for component values (no $path)', () => {
    const source = fakeSource({});
    const comp: ComponentData = { $type: 'demo.comp', title: 'Just a component' };

    renderWithProviders(source, comp);

    assert.equal(screen.queryByText('List'), null, 'no switcher for components');
  });

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

    render(createElement(TooltipProvider, null,
      createElement(Render, { value: { $type: 'demo.ref-holder', target: { $ref: '/x' } } }),
    ));

    assert.equal(screen.getByText('ref:/x').textContent, 'ref:/x');
  });
});
