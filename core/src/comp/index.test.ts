// Tests for getComp, setComp, newComp
// Key behavior: when node.$type matches component $type, node itself IS the component.

import { getComp, newComp, registerType, setComp } from '#comp';
import { type NodeData } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

class TestItem {
  name = '';
  quantity = 0;
}
registerType('test.item', TestItem);

class TestMeta {
  title = '';
  description = '';
}
registerType('test.meta', TestMeta);

// ── getComp ──

describe('getComp', () => {
  it('returns node itself when node.$type matches component type', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'sword', quantity: 3 };
    const comp = getComp(node, TestItem);
    assert.ok(comp);
    assert.equal(comp.name, 'sword');
    assert.equal(comp.quantity, 3);
  });

  it('returns named-key component when types differ', () => {
    const node: NodeData = {
      $path: '/a', $type: 'dir',
      meta: { $type: 'test.meta', title: 'Hello', description: 'world' },
    };
    const comp = getComp(node, TestMeta);
    assert.ok(comp);
    assert.equal(comp.title, 'Hello');
    assert.equal(comp.description, 'world');
  });

  it('prefers node-level over named key when both have same $type', () => {
    // This is the "wrong data shape" scenario — node-level wins, named key is ignored
    const node: NodeData = {
      $path: '/a', $type: 'test.item',
      item: { $type: 'test.item', name: 'from-key', quantity: 99 },
    };
    const comp = getComp(node, TestItem);
    assert.ok(comp);
    // Node-level has no name/quantity fields → undefined, not the named key values
    assert.equal(comp.name, undefined);
    assert.equal(comp.quantity, undefined);
  });

  it('returns undefined when no match', () => {
    const node: NodeData = { $path: '/a', $type: 'dir' };
    assert.equal(getComp(node, TestItem), undefined);
  });
});

// ── setComp ──

describe('setComp', () => {
  it('updates node directly for node-level component', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'old', quantity: 1 };
    setComp(node, TestItem, { name: 'new', quantity: 5 });
    assert.equal(node.name, 'new');
    assert.equal(node.quantity, 5);
  });

  it('updates named-key component', () => {
    const node: NodeData = {
      $path: '/a', $type: 'dir',
      meta: { $type: 'test.meta', title: 'old', description: 'old' },
    };
    setComp(node, TestMeta, { title: 'new' });
    assert.equal((node.meta as any).title, 'new');
    assert.equal((node.meta as any).description, 'old'); // not overwritten
  });

  it('creates new named-key component when not found', () => {
    const node: NodeData = { $path: '/a', $type: 'dir' };
    setComp(node, TestItem, { name: 'created', quantity: 10 });
    // default key = last segment of $type = 'item'
    assert.ok(node.item);
    assert.equal((node.item as any).$type, 'test.item');
    assert.equal((node.item as any).name, 'created');
    assert.equal((node.item as any).quantity, 10);
  });

  it('partial update preserves existing fields on node-level', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'keep', quantity: 1 };
    setComp(node, TestItem, { quantity: 99 });
    assert.equal(node.name, 'keep');
    assert.equal(node.quantity, 99);
  });

  it('preserves $path and $type on node-level update', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'x', quantity: 0 };
    setComp(node, TestItem, { name: 'y' });
    assert.equal(node.$path, '/a');
    assert.equal(node.$type, 'test.item');
  });

  it('throws when key already exists with different content', () => {
    const node: NodeData = { $path: '/a', $type: 'dir', meta: { $type: 'other', x: 1 } };
    assert.throws(
      () => setComp(node, TestMeta, { title: 'fail' }),
      (e: Error) => e.message.includes('already exists'),
    );
  });
});

// ── newComp ──

describe('newComp', () => {
  it('creates component with $type and data', () => {
    const comp = newComp(TestItem, { name: 'sword', quantity: 3 });
    assert.equal(comp.$type, 'test.item');
    assert.equal(comp.name, 'sword');
    assert.equal(comp.quantity, 3);
  });

  it('$type cannot be overridden by data', () => {
    const comp = newComp(TestItem, { name: 'x', $type: 'hacked' } as any);
    assert.equal(comp.$type, 'test.item');
  });
});
