import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { register } from '@treenx/core';
import type { NodeData } from '@treenx/core';
import { render } from './entry-server';
import type { TreeSource } from '#tree/tree-source';
import {
  EMPTY_PATH_SNAPSHOT,
  EMPTY_CHILDREN_SNAPSHOT,
  NOOP_PATH_HANDLE,
  NOOP_CHILDREN_HANDLE,
} from '#tree/tree-source';

const noopSource: TreeSource = {
  getPathSnapshot: () => EMPTY_PATH_SNAPSHOT,
  getChildrenSnapshot: () => EMPTY_CHILDREN_SNAPSHOT,
  subscribePath: () => () => {},
  subscribeChildren: () => () => {},
  mountPath: () => NOOP_PATH_HANDLE,
  mountChildren: () => NOOP_CHILDREN_HANDLE,
};

describe('entry-server.render', () => {
  it('static mode renders a registered site view without React markers', () => {
    register('test.ssr.box', 'site', ({ value }: { value: NodeData & { label?: string } }) =>
      createElement('div', { 'data-label': value.label }, value.label ?? ''));
    const node = { $path: '/x', $type: 'test.ssr.box', label: 'hi' } as NodeData;
    const html = render({ source: noopSource, node, rest: '', mode: 'static' });
    assert.ok(html.includes('data-label="hi"'));
    assert.ok(html.includes('hi</div>'));
    // Static markup omits React's data-reactroot / hydration comments.
    assert.ok(!html.includes('<!--$-->'));
  });

  it('hydrate mode renders the same markup (also no react-root marker in 19)', () => {
    register('test.ssr.box2', 'site', ({ value }: { value: NodeData & { label?: string } }) =>
      createElement('div', { 'data-label': value.label }, value.label ?? ''));
    const node = { $path: '/x', $type: 'test.ssr.box2', label: 'yo' } as NodeData;
    const html = render({ source: noopSource, node, rest: '', mode: 'hydrate' });
    assert.ok(html.includes('data-label="yo"'));
  });

  it('renders to empty when no site view registered', () => {
    const node = { $path: '/y', $type: 'test.ssr.unregistered' } as NodeData;
    const html = render({ source: noopSource, node, rest: '', mode: 'static' });
    assert.equal(html, '');
  });
});
