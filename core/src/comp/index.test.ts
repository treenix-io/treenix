// Tests for setComponent, newComponent, getCtx
// Key behavior: when node.$type matches component $type, node itself IS the component.

import { getCtx, newComponent, registerActions, registerType, setComponent } from '#comp';
import { createNode, getComponent, getMeta, type NodeData, register, resolve } from '#core';
import { clearRegistry } from '#testing';
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

// ── getComponent ──

describe('getComponent', () => {
  it('returns node itself when node.$type matches component type', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'sword', quantity: 3 };
    const comp = getComponent(node, TestItem);
    assert.ok(comp);
    assert.equal(comp.name, 'sword');
    assert.equal(comp.quantity, 3);
  });

  it('returns named-key component when types differ', () => {
    const node: NodeData = {
      $path: '/a', $type: 'dir',
      '#meta': { $type: 'test.meta', title: 'Hello', description: 'world' },
    };
    const comp = getComponent(node, TestMeta);
    assert.ok(comp);
    assert.equal(comp.title, 'Hello');
    assert.equal(comp.description, 'world');
  });

  it('prefers node-level over named key when both have same $type', () => {
    // This is the "wrong data shape" scenario — node-level wins, named key is ignored
    const node: NodeData = {
      $path: '/a', $type: 'test.item',
      '#item': { $type: 'test.item', name: 'from-key', quantity: 99 },
    };
    const comp = getComponent(node, TestItem);
    assert.ok(comp);
    // Node-level has no name/quantity fields → undefined, not the named key values
    assert.equal(comp.name, undefined);
    assert.equal(comp.quantity, undefined);
  });

  it('returns undefined when no match', () => {
    const node: NodeData = { $path: '/a', $type: 'dir' };
    assert.equal(getComponent(node, TestItem), undefined);
  });
});

// ── setComponent ──

describe('setComponent', () => {
  it('updates node directly for node-level component', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'old', quantity: 1 };
    setComponent(node, TestItem, { name: 'new', quantity: 5 });
    assert.equal(node.name, 'new');
    assert.equal(node.quantity, 5);
  });

  it('updates named-key component', () => {
    const node: NodeData = {
      $path: '/a', $type: 'dir',
      '#meta': { $type: 'test.meta', title: 'old', description: 'old' },
    };
    setComponent(node, TestMeta, { title: 'new' });
    assert.equal((node['#meta'] as any).title, 'new');
    assert.equal((node['#meta'] as any).description, 'old'); // not overwritten
  });

  it('creates new named-key component when not found', () => {
    const node: NodeData = { $path: '/a', $type: 'dir' };
    setComponent(node, TestItem, { name: 'created', quantity: 10 });
    // default key = last segment of $type = 'item', stored at '#item'
    assert.ok(node['#item']);
    assert.equal((node['#item'] as any).$type, 'test.item');
    assert.equal((node['#item'] as any).name, 'created');
    assert.equal((node['#item'] as any).quantity, 10);
  });

  it('partial update preserves existing fields on node-level', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'keep', quantity: 1 };
    setComponent(node, TestItem, { quantity: 99 });
    assert.equal(node.name, 'keep');
    assert.equal(node.quantity, 99);
  });

  it('preserves $path and $type on node-level update', () => {
    const node: NodeData = { $path: '/a', $type: 'test.item', name: 'x', quantity: 0 };
    setComponent(node, TestItem, { name: 'y' });
    assert.equal(node.$path, '/a');
    assert.equal(node.$type, 'test.item');
  });

  it('throws when key already exists with different content', () => {
    const node: NodeData = { $path: '/a', $type: 'dir', '#meta': { $type: 'other', x: 1 } };
    assert.throws(
      () => setComponent(node, TestMeta, { title: 'fail' }),
      (e: Error) => e.message.includes('already exists'),
    );
  });
});

// ── newComponent ──

describe('newComponent', () => {
  it('creates component with $type and data', () => {
    const comp = newComponent(TestItem, { name: 'sword', quantity: 3 });
    assert.equal(comp.$type, 'test.item');
    assert.equal(comp.name, 'sword');
    assert.equal(comp.quantity, 3);
  });

  it('$type cannot be overridden by data', () => {
    const comp = newComponent(TestItem, { name: 'x', $type: 'hacked' } as any);
    assert.equal(comp.$type, 'test.item');
  });
});

// ── getCtx ──

describe('getCtx', () => {
  it('throws when called outside action context', () => {
    assert.throws(() => getCtx(), (e: Error) => e.message.includes('outside action context'));
  });
});

// ── registerType: noOptimistic meta ──

describe('registerType noOptimistic', () => {
  it('sets noOptimistic meta on specified actions', () => {
    clearRegistry();

    class TokenMgr {
      create() {}
      list() { return []; }
    }
    registerType('test.tokens', TokenMgr, { noOptimistic: ['create'] });

    const createMeta = getMeta('test.tokens', 'action:create');
    assert.ok(createMeta?.noOptimistic);

    const listMeta = getMeta('test.tokens', 'action:list');
    assert.equal(listMeta?.noOptimistic, undefined);
  });
});

// ── registerType: stream meta ──

describe('registerType stream', () => {
  it('sets stream meta on async generator methods', () => {
    clearRegistry();

    class Streamer {
      async *follow() { yield 1; }
      ping() { return 'pong'; }
    }
    registerType('test.streamer', Streamer);

    const followMeta = getMeta('test.streamer', 'action:follow');
    assert.ok(followMeta?.stream);

    const pingMeta = getMeta('test.streamer', 'action:ping');
    assert.equal(pingMeta?.stream, undefined);
  });
});
