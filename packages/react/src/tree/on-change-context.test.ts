import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createNode } from '@treenx/core';
import { $key, $node, componentLocation, stampNode } from '#symbols';
import { mergeIntoNode } from './on-change';

it('retains node and named-component locations through optimistic nested edits', () => {
  const settings = { $type: 'example.settings', title: 'before' };
  const node = createNode('/example', 'example', {}, { settings });
  stampNode(node);
  const merged = mergeIntoNode(node, { '#settings.title': 'after' });

  assert.equal(merged['#settings'].title, 'after');
  assert.equal(node['#settings'].title, 'before');
  assert.equal(componentLocation(merged)[$node], node);
  assert.equal(componentLocation(merged['#settings'])[$node], node);
  assert.equal(componentLocation(merged['#settings'])[$key], '#settings');
  assert.equal(JSON.stringify(merged).includes('treenix.$node'), false);
});

it('keeps a detached presentation value detached after an optimistic edit', () => {
  const merged = mergeIntoNode({ title: 'before' }, { title: 'after' });

  assert.equal(merged.title, 'after');
  assert.equal(componentLocation(merged)[$node], undefined);
  assert.equal(componentLocation(merged)[$key], undefined);
});
