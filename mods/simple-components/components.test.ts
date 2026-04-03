// Universal component tests — action contracts

import { resolve } from '@treenity/core';
import './types';
import { createMemoryTree } from '@treenity/core/tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NodeData } from '@treenity/core';

function makeNode(componentKey: string, componentType: string, componentData: Record<string, unknown>): NodeData {
  return {
    $path: '/test/node',
    $type: 'dir',
    [componentKey]: { $type: componentType, ...componentData },
  } as NodeData;
}

async function execComp(tree: ReturnType<typeof createMemoryTree>, path: string, compType: string, action: string, data?: unknown) {
  const handler = resolve(compType, `action:${action}`) as any;
  assert.ok(handler, `action:${action} must be registered for ${compType}`);
  const node = await tree.get(path);
  assert.ok(node, `node at ${path} must exist`);
  await handler({ node, comp: node, tree, signal: AbortSignal.timeout(5000) }, data);
  await tree.set(node);
  return node;
}

// ── simple.checklist ──

describe('simple.checklist', () => {
  it('registers add/toggle/remove actions', () => {
    assert.ok(resolve('simple.checklist', 'action:add'));
    assert.ok(resolve('simple.checklist', 'action:toggle'));
    assert.ok(resolve('simple.checklist', 'action:remove'));
  });

  it('add creates an item with id', async () => {
    const handler = resolve('simple.checklist', 'action:add') as any;
    const comp = { items: [] as { id: number; text: string; done: boolean }[] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { text: 'Buy milk' });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].text, 'Buy milk');
    assert.equal(comp.items[0].done, false);
    assert.equal(typeof comp.items[0].id, 'number');
  });

  it('toggle flips done state by id', async () => {
    const handler = resolve('simple.checklist', 'action:toggle') as any;
    const comp = { items: [{ id: 1, text: 'A', done: false }] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { id: 1 });
    assert.equal(comp.items[0].done, true);
  });

  it('remove deletes item by id', async () => {
    const handler = resolve('simple.checklist', 'action:remove') as any;
    const comp = { items: [{ id: 1, text: 'A', done: false }, { id: 2, text: 'B', done: false }] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { id: 1 });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].text, 'B');
  });

  it('add throws on empty text', async () => {
    const handler = resolve('simple.checklist', 'action:add') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { items: [] }, tree: null, signal: AbortSignal.timeout(5000) }, { text: '' }); },
      (err: Error) => err.message.includes('text'),
    );
  });

  it('toggle throws on invalid id', async () => {
    const handler = resolve('simple.checklist', 'action:toggle') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { items: [] }, tree: null, signal: AbortSignal.timeout(5000) }, { id: 999 }); },
      (err: Error) => err.message.includes('id'),
    );
  });
});

// ── simple.tags ──

describe('simple.tags', () => {
  it('registers add/remove actions', () => {
    assert.ok(resolve('simple.tags', 'action:add'));
    assert.ok(resolve('simple.tags', 'action:remove'));
  });

  it('add appends a tag', async () => {
    const handler = resolve('simple.tags', 'action:add') as any;
    const comp = { items: ['existing'] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { tag: 'new' });
    assert.deepEqual(comp.items, ['existing', 'new']);
  });

  it('add deduplicates', async () => {
    const handler = resolve('simple.tags', 'action:add') as any;
    const comp = { items: ['bug'] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { tag: 'bug' });
    assert.equal(comp.items.length, 1);
  });

  it('remove deletes a tag', async () => {
    const handler = resolve('simple.tags', 'action:remove') as any;
    const comp = { items: ['a', 'b', 'c'] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { tag: 'b' });
    assert.deepEqual(comp.items, ['a', 'c']);
  });

  it('add throws on empty tag', async () => {
    const handler = resolve('simple.tags', 'action:add') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { items: [] }, tree: null, signal: AbortSignal.timeout(5000) }, { tag: '  ' }); },
      (err: Error) => err.message.includes('tag'),
    );
  });
});

// ── simple.estimate ──

describe('simple.estimate', () => {
  it('registers update action', () => {
    assert.ok(resolve('simple.estimate', 'action:update'));
  });

  it('update sets value and unit', async () => {
    const handler = resolve('simple.estimate', 'action:update') as any;
    const comp = { value: 0, unit: 'hours' };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { value: 5, unit: 'points' });
    assert.equal(comp.value, 5);
    assert.equal(comp.unit, 'points');
  });

  it('update keeps unit if not provided', async () => {
    const handler = resolve('simple.estimate', 'action:update') as any;
    const comp = { value: 0, unit: 'days' };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { value: 3 });
    assert.equal(comp.value, 3);
    assert.equal(comp.unit, 'days');
  });

  it('update throws on negative value', async () => {
    const handler = resolve('simple.estimate', 'action:update') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { value: 0, unit: 'hours' }, tree: null, signal: AbortSignal.timeout(5000) }, { value: -1 }); },
      (err: Error) => err.message.includes('value'),
    );
  });
});

// ── simple.links ──

describe('simple.links', () => {
  it('registers add/remove actions', () => {
    assert.ok(resolve('simple.links', 'action:add'));
    assert.ok(resolve('simple.links', 'action:remove'));
  });

  it('add creates a link with id', async () => {
    const handler = resolve('simple.links', 'action:add') as any;
    const comp = { items: [] as { id: number; url: string; label: string }[] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { url: 'https://x.com', label: 'X' });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].url, 'https://x.com');
    assert.equal(comp.items[0].label, 'X');
    assert.equal(typeof comp.items[0].id, 'number');
  });

  it('add uses empty label by default', async () => {
    const handler = resolve('simple.links', 'action:add') as any;
    const comp = { items: [] as { id: number; url: string; label: string }[] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { url: 'https://x.com' });
    assert.equal(comp.items[0].label, '');
  });

  it('remove deletes by id', async () => {
    const handler = resolve('simple.links', 'action:remove') as any;
    const comp = { items: [{ id: 1, url: 'a', label: '' }, { id: 2, url: 'b', label: '' }] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { id: 1 });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].url, 'b');
  });

  it('add throws on empty url', async () => {
    const handler = resolve('simple.links', 'action:add') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { items: [] }, tree: null, signal: AbortSignal.timeout(5000) }, { url: '' }); },
      (err: Error) => err.message.includes('url'),
    );
  });
});

// ── simple.comments ──

describe('simple.comments', () => {
  it('registers add action', () => {
    assert.ok(resolve('simple.comments', 'action:add'));
  });

  it('add creates a comment with timestamp', async () => {
    const handler = resolve('simple.comments', 'action:add') as any;
    const comp = { items: [] as { author: string; text: string; createdAt: number }[] };
    const before = Date.now();
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { text: 'hello', author: 'bob' });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].text, 'hello');
    assert.equal(comp.items[0].author, 'bob');
    assert.ok(comp.items[0].createdAt >= before);
  });

  it('add defaults author to anonymous', async () => {
    const handler = resolve('simple.comments', 'action:add') as any;
    const comp = { items: [] as any[] };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) }, { text: 'hi' });
    assert.equal(comp.items[0].author, 'anonymous');
  });

  it('add throws on empty text', async () => {
    const handler = resolve('simple.comments', 'action:add') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { items: [] }, tree: null, signal: AbortSignal.timeout(5000) }, { text: '' }); },
      (err: Error) => err.message.includes('text'),
    );
  });
});

// ── simple.time-track ──

describe('simple.time-track', () => {
  it('registers start/stop actions', () => {
    assert.ok(resolve('simple.time-track', 'action:start'));
    assert.ok(resolve('simple.time-track', 'action:stop'));
  });

  it('start creates an entry and sets running', async () => {
    const handler = resolve('simple.time-track', 'action:start') as any;
    const comp = { entries: [] as { start: number; end: number }[], running: false };
    const before = Date.now();
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) });
    assert.equal(comp.running, true);
    assert.equal(comp.entries.length, 1);
    assert.ok(comp.entries[0].start >= before);
    assert.equal(comp.entries[0].end, 0);
  });

  it('stop closes the entry and clears running', async () => {
    const handler = resolve('simple.time-track', 'action:stop') as any;
    const before = Date.now();
    const comp = { entries: [{ start: before - 1000, end: 0 }], running: true };
    await handler({ node: {}, comp, tree: null, signal: AbortSignal.timeout(5000) });
    assert.equal(comp.running, false);
    assert.ok(comp.entries[0].end >= before);
  });

  it('start throws if already running', async () => {
    const handler = resolve('simple.time-track', 'action:start') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { entries: [], running: true }, tree: null, signal: AbortSignal.timeout(5000) }); },
      (err: Error) => err.message.includes('running'),
    );
  });

  it('stop throws if not running', async () => {
    const handler = resolve('simple.time-track', 'action:stop') as any;
    await assert.rejects(
      async () => { await handler({ node: {}, comp: { entries: [], running: false }, tree: null, signal: AbortSignal.timeout(5000) }); },
      (err: Error) => err.message.includes('running'),
    );
  });
});
